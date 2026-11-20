import { describe, expect, it } from 'vitest';
import { FieldSpec, newId, type FieldMeta, type RowData } from '@riosoma/contracts';
import { rollupFunctions } from '../screens/database/fields/RelationalOptions';
import { checkFormula, formulaComputer, formulaDisplay, namesRead, resultType } from './formulas';

const tableId = newId('table');
const at = '2026-01-01T00:00:00.000Z';
const context = { now: new Date(at), timeZone: 'UTC' };

function field(name: string, spec: unknown): FieldMeta {
  return {
    id: newId('field'),
    tableId,
    name,
    description: '',
    position: 0,
    createdAt: at,
    updatedAt: at,
    ...FieldSpec.parse(spec),
  };
}

function row(values: RowData['values'], errors?: RowData['errors']): RowData {
  return {
    id: newId('record'),
    values,
    ...(errors ? { errors } : {}),
    createdAt: at,
    createdBy: null,
    updatedAt: at,
    updatedBy: null,
  };
}

/** A formula as the server stores it, with the result type it worked out. */
const formula = (name: string, expression: string, resultType = 'number') =>
  field(name, { type: 'formula', options: { expression, resultType } });

describe('formulas the app checks and computes', () => {
  it.each(['REMOVED', 'DATETIME_FORMAT', 'LEFT'])('displays field names in an invalid %s call', (name) => {
    const amount = field('金额 😀 المبلغ', { type: 'number' });
    expect(formulaDisplay(`${name}({${amount.id}}, 1, 2, 3)`, [amount])).toBe(
      `${name}({金额 😀 المبلغ}, 1, 2, 3)`,
    );
  });

  it('reads currency, percent, duration, rating, and auto number fields as numbers', () => {
    const price = field('Price', { type: 'currency' });
    const share = field('Share', { type: 'percent' });
    const time = field('Time', { type: 'duration' });
    const stars = field('Stars', { type: 'rating' });
    const number = field('Number', { type: 'autoNumber' });
    const fields = [price, share, time, stars, number];
    for (const item of fields) {
      expect(resultType(item), item.type).toBe('number');
      expect(rollupFunctions(item), item.type).toEqual(expect.arrayContaining(['sum', 'average']));
    }
    expect(checkFormula('{Price} * 2 + {Share} + {Time} / 60 + {Stars} + {Number}', fields)).toMatchObject({
      type: 'number',
    });
    const key = formula('Key', '"BUG-" & {Number}', 'text');
    const cost = formula('Cost', '"$" & {Price} & " at " & {Share}', 'text');
    expect(checkFormula(key.type === 'formula' ? key.options.expression : '', fields)).toMatchObject({
      type: 'text',
    });
    const computed = formulaComputer([...fields, key, cost])(
      row({ [price.id]: 12.5, [share.id]: 0.25, [number.id]: 7 }),
      context,
    );
    expect(computed.values).toMatchObject({ [key.id]: 'BUG-7', [cost.id]: '$12.5 at 0.25' });
    expect(computed.errors).toEqual({});
  });

  it('passes a rollup’s error, and another formula’s, on to the formulas that read them', () => {
    const rollup = field('Signed up', {
      type: 'rollup',
      options: {
        linkFieldId: newId('field'),
        targetFieldId: newId('field'),
        fn: 'sum',
        resultType: 'number',
      },
    });
    const open = formula('Open spots', 'MAX(0, 5 - {Signed up})');
    const caught = formula('Caught', 'IF(ISERROR({Signed up}), -1, {Signed up})');
    const ratio = formula('Ratio', '1 / {Signed up}');
    const guarded = formula('Guarded', 'IF(ISERROR({Ratio}), 0, {Ratio})');
    const compute = formulaComputer([rollup, open, caught, ratio, guarded]);
    const failed = compute(row({ [rollup.id]: null }, { [rollup.id]: 'formula.runtime.explicit' }), context);
    expect(failed.values).toMatchObject({ [open.id]: null, [caught.id]: -1, [guarded.id]: 0 });
    expect(failed.errors).toEqual({
      [rollup.id]: 'formula.runtime.explicit',
      [open.id]: 'formula.runtime.explicit',
      [ratio.id]: 'formula.runtime.explicit',
    });
    const empty = compute(row({ [rollup.id]: 0 }), context);
    expect(empty.values).toMatchObject({ [open.id]: 5, [caught.id]: 0, [ratio.id]: null, [guarded.id]: 0 });
    expect(empty.errors).toEqual({ [ratio.id]: 'formula.runtime.divisionByZero' });
  });

  it('reads people fields as lists of names, as the server does', () => {
    const owner = field('Owner', { type: 'user', options: { allowMultiple: true } });
    const label = formula('Label', '"Owner: " & {Owner}', 'text');
    expect(resultType(owner)).toBe('array');
    expect(checkFormula('LEN({Owner})', [owner])).toMatchObject({
      error: { messageKey: 'formula.type.argument' },
    });
    const person = newId('user');
    const computed = formulaComputer([owner, label])(row({ [owner.id]: [person] }), {
      ...context,
      people: new Map([[person, 'Ada Lovelace']]),
    });
    expect(computed.values[label.id]).toBe('Owner: Ada Lovelace');
  });

  it('reads a looked-up price as one value in arithmetic, as the server does', () => {
    const lookup = (name: string, resultType: string) =>
      field(name, {
        type: 'lookup',
        options: { linkFieldId: newId('field'), targetFieldId: newId('field'), resultType },
      });
    const price = lookup('Price', 'number');
    const product = lookup('Product', 'text');
    const quantity = field('Quantity', { type: 'number' });
    const fields = [price, product, quantity];
    expect(checkFormula('{Price} * {Quantity}', fields)).toMatchObject({
      type: 'number',
      oneValue: [price.id],
    });
    expect(checkFormula('SUM({Price}) + COUNT({Product})', fields)).toMatchObject({
      type: 'number',
      oneValue: [],
    });
    expect(checkFormula('{Product} * 2', fields)).toMatchObject({
      error: { messageKey: 'formula.type.argument' },
    });
    const total = formula('Total', '{Price} * {Quantity}');
    const compute = formulaComputer([...fields, total]);
    const read = (values: RowData['values']) => compute(row({ [quantity.id]: 3, ...values }), context);
    expect(read({ [price.id]: [2.5] }).values[total.id]).toBe(7.5);
    expect(read({ [price.id]: [] }).values[total.id]).toBe(0);
    const several = read({ [price.id]: [2.5, 4] });
    expect(several.values[total.id]).toBeNull();
    expect(several.errors).toEqual({ [total.id]: 'formula.list.several' });
  });
});

describe('formulas over links and choices, which read by name', () => {
  const linkedTableId = newId('table');
  const clientName = field('Name', { type: 'text' });
  const clients = { ...field('Client', { type: 'link', options: { linkedTableId } }) };
  const number = field('Order Number', { type: 'number' });
  const label = formula('Label', '{Client} & " Order #" & {Order Number}', 'text');
  const matches = formula('Forrester', '{Client} = "Forrester Legal Partners"', 'boolean');
  const [forrester, smith] = [newId('record'), newId('record')];
  const names = new Map([
    [forrester, 'Forrester Legal Partners'],
    [smith, 'Smith, Jones & Co.'],
  ]);

  it('reads a link as the names the server gave its records, and waits for names it hasn’t', () => {
    expect(checkFormula('{Client} = "Forrester"', [clients])).toMatchObject({
      type: 'boolean',
      oneValue: [clients.id],
    });
    const compute = formulaComputer([clients, number, label, matches]);
    const read = compute(row({ [clients.id]: [forrester], [number.id]: 420 }), { ...context, names });
    expect(read.values).toMatchObject({
      [label.id]: 'Forrester Legal Partners Order #420',
      [matches.id]: true,
    });
    const both = compute(row({ [clients.id]: [smith, forrester], [number.id]: 7 }), { ...context, names });
    expect(both.values[label.id]).toBe('Smith, Jones & Co., Forrester Legal Partners Order #7');
    expect(both.errors).toEqual({ [matches.id]: 'formula.list.several' });
    expect(compute(row({ [number.id]: 1 }), { ...context, names }).values[label.id]).toBe(' Order #1');
    // A record whose name this session hasn't heard keeps what the server computed.
    const stranger = newId('record');
    const kept = compute(
      row(
        { [clients.id]: [stranger], [number.id]: 3, [label.id]: 'Server Order #3', [matches.id]: null },
        { [matches.id]: 'formula.list.several' },
      ),
      { ...context, names },
    );
    expect(kept.values).toMatchObject({ [label.id]: 'Server Order #3', [matches.id]: null });
    expect(kept.errors).toEqual({ [matches.id]: 'formula.list.several' });
  });

  it('keeps the server’s value when the linked table is named by a formula only JavaScript computes', () => {
    const firm = { ...field('Firm', { type: 'text' }), tableId: linkedTableId };
    const named = (sortable: boolean) => ({
      ...field('Name', {
        type: 'formula',
        options: { expression: `LOWER({${firm.id}})`, resultType: 'text', sortable },
      }),
      tableId: linkedTableId,
    });
    const compute = formulaComputer([clients, number, label]);
    const read = (primary: FieldMeta) =>
      compute(
        row(
          { [clients.id]: [forrester], [number.id]: 420, [label.id]: null },
          { [label.id]: 'formula.link.unnamed' },
        ),
        {
          ...context,
          names,
          fieldById: new Map([primary, firm, clients].map((item) => [item.id, item])),
          tableById: new Map([[linkedTableId, { primaryFieldId: primary.id }]]),
        },
      );
    expect(read(named(false)).errors).toEqual({ [label.id]: 'formula.link.unnamed' });
    const sortable = read(named(true));
    expect(sortable.values[label.id]).toBe('Forrester Legal Partners Order #420');
    expect(sortable.errors).toEqual({});
  });

  it('reads lookups of choices and of links by name, leaving out blank names and choices that are gone', () => {
    const done = newId('choice'),
      doing = newId('choice'),
      gone = newId('choice');
    const status = {
      ...field('Status', {
        type: 'singleSelect',
        options: {
          choices: [
            { id: done, name: 'Done', color: 'green' },
            { id: doing, name: 'In progress', color: 'blue' },
          ],
        },
      }),
      tableId: linkedTableId,
    };
    const orders = {
      ...field('Orders', { type: 'link', options: { linkedTableId: tableId } }),
      tableId: linkedTableId,
    };
    const lookup = (name: string, targetFieldId: string) =>
      field(name, {
        type: 'lookup',
        options: { linkFieldId: clients.id, targetFieldId, resultType: 'text' },
      });
    const statuses = lookup('Statuses', status.id);
    const related = lookup('Related', orders.id);
    const shown = formula('Shown', '{Statuses} & " / " & {Related}', 'text');
    const first = formula('First', '{Statuses} = "Done"', 'boolean');
    const fields = [clients, statuses, related, shown, first];
    const fieldById = new Map([...fields, status, orders, clientName].map((item) => [item.id, item]));
    const [one, two] = [newId('record'), newId('record')];
    const known = new Map([
      [one, 'Order one'],
      [two, ''],
    ]);
    const compute = formulaComputer(fields);
    const read = compute(row({ [statuses.id]: [done, gone, doing], [related.id]: [one, two] }), {
      ...context,
      names: known,
      fieldById,
    });
    expect(read.values).toMatchObject({ [shown.id]: 'Done, In progress / Order one', [first.id]: null });
    expect(read.errors).toEqual({ [first.id]: 'formula.list.several' });
    expect(
      compute(row({ [statuses.id]: [done] }), { ...context, names: known, fieldById }).values[first.id],
    ).toBe(true);
  });

  it('says which tables’ names a table’s formulas read, through other formulas and lookups of links', () => {
    const other = newId('table');
    const reach = {
      ...field('Reach', { type: 'link', options: { linkedTableId: other } }),
      tableId: linkedTableId,
    };
    const through = field('Through', {
      type: 'lookup',
      options: { linkFieldId: clients.id, targetFieldId: reach.id, resultType: 'text' },
    });
    const outer = formula('Outer', '{Label} & {Through}', 'text');
    const fieldById = new Map([clients, number, label, reach, through, outer].map((item) => [item.id, item]));
    expect(namesRead([clients, number, label], fieldById)).toEqual(new Set([linkedTableId]));
    expect(namesRead([clients, number, through, label, outer], fieldById)).toEqual(
      new Set([linkedTableId, other]),
    );
    expect(namesRead([clients, number], fieldById)).toEqual(new Set());
  });
});

it('keeps named calls editable and computes against the supplied database registry', () => {
  const amount = field('Amount', { type: 'number' });
  const functions = [{ name: 'NET', parameters: ['amount', 'discount'], body: 'amount * (1 - discount)' }];
  const checked = checkFormula('NET({Amount}, 0.2)', [amount], undefined, [], tableId, functions);
  expect(checked).toMatchObject({ expression: `NET({${amount.id}}, 0.2)`, type: 'number' });
  const computed = formula('Net', `NET({${amount.id}}, 0.2)`);
  const compute = formulaComputer([amount, computed], functions);
  expect(compute(row({ [amount.id]: 100 }), context).values[computed.id]).toBe(80);
  expect(checkFormula('NET({Amount})', [amount], undefined, [], tableId, functions)).toMatchObject({
    error: { messageKey: 'formula.function.arity' },
  });
  expect(checkFormula('NET({Amount}, 0.2)', [amount])).toMatchObject({
    error: { messageKey: 'formula.function.unknown' },
  });
});

it('preserves server results for table references when only the current table is loaded', () => {
  const functions = [{ name: 'TOTAL', parameters: ['amounts'], body: 'SUM(amounts)' }];
  for (const expression of ['SUM(Other[Amount])', 'TOTAL(Other[Amount])']) {
    const computed = formula('Total', expression);
    const source = row({ [computed.id]: 42 });
    expect(formulaComputer([computed], functions)(source, context).values[computed.id]).toBe(42);
  }
});
