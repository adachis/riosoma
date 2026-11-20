import { afterEach, describe, expect, it } from 'vitest';
import { AutomationConfig } from '@riosoma/contracts';
import { followRecords, newStep, triggerOfKind } from './model';
import { findProblems } from './problems';
import { automationFixture, type AutomationFixture } from './test-support';
import {
  formatHeaders,
  joinList,
  parseHeaders,
  readToken,
  splitList,
  splitTemplate,
  tokensIn,
} from './tokens';

const fixtures: AutomationFixture[] = [];
afterEach(() => {
  fixtures.splice(0).forEach((fixture) => fixture.session.close());
});

async function database() {
  const fixture = await automationFixture();
  fixtures.push(fixture);
  return fixture;
}

describe('templates', () => {
  it('split text from the tokens they recognize, leaving other braces as text', () => {
    const field = 'fld0123456789ABCD';
    expect(splitTemplate(`Hi {{ trigger.record.${field} }} at {{now}} {{nope}}`)).toEqual([
      { kind: 'text', text: 'Hi ' },
      { kind: 'token', token: `trigger.record.${field}` },
      { kind: 'text', text: ' at ' },
      { kind: 'token', token: 'now' },
      { kind: 'text', text: ' {{nope}}' },
    ]);
    expect(readToken('steps.step_one.record.fld0123456789ABCD')).toEqual({
      kind: 'stepField',
      stepId: 'step_one',
      fieldId: 'fld0123456789ABCD',
    });
    expect(readToken('trigger.body.customer.email')).toEqual({ kind: 'body', path: 'customer.email' });
    expect(readToken('trigger.body.')).toBeNull();
    expect(tokensIn('{{trigger.record.url}}')).toEqual([{ kind: 'link' }]);
  });

  it('read lists of addresses and headers the way people write them', () => {
    expect(splitList('a@example.test, b@example.test;\nc@example.test,')).toEqual([
      'a@example.test',
      'b@example.test',
      'c@example.test',
    ]);
    expect(splitList(' ')).toEqual(['']);
    expect(joinList([''])).toBe('');
    expect(parseHeaders('Authorization: Bearer a:b\nbroken\n: none\nX-Test:1')).toEqual({
      Authorization: 'Bearer a:b',
      'X-Test': '1',
    });
    expect(formatHeaders({ Accept: 'application/json' })).toBe('Accept: application/json');
  });
});

describe('the configuration', () => {
  it('keeps update steps on the table their record comes from', async () => {
    const { session, tasks, people } = await database();
    const schema = session.getSchema();
    const config = AutomationConfig.parse({
      trigger: { kind: 'recordCreated', tableId: people.id },
      steps: [{ id: 'change_it', kind: 'updateRecord', record: 'trigger', tableId: tasks.id, values: {} }],
    });
    expect(followRecords(config, schema).steps[0]).toMatchObject({ tableId: people.id });
    expect(followRecords(followRecords(config, schema), schema)).toEqual(followRecords(config, schema));
  });

  it('changes the kind of trigger, keeping its table where it can', async () => {
    const { session, tasks } = await database();
    const schema = session.getSchema();
    const created = { kind: 'recordCreated' as const, tableId: tasks.id };
    expect(triggerOfKind('recordUpdated', created, schema, tasks.id)).toEqual({
      kind: 'recordUpdated',
      tableId: tasks.id,
      fieldIds: [],
    });
    expect(triggerOfKind('formSubmitted', created, schema, tasks.id)).toEqual({
      kind: 'formSubmitted',
      viewId: tasks.formId,
    });
    expect(triggerOfKind('webhook', created, schema, tasks.id)).toEqual({ kind: 'webhook' });
  });

  it('starts an update step on a record an earlier step made when no record starts it', async () => {
    const { session, people } = await database();
    const schema = session.getSchema();
    const config = AutomationConfig.parse({
      trigger: { kind: 'webhook' },
      steps: [{ id: 'make_one', kind: 'createRecord', tableId: people.id, values: {} }],
    });
    expect(newStep('updateRecord', config, 1, schema, people.id)).toMatchObject({
      record: 'make_one',
      tableId: people.id,
    });
  });

  it('finds deleted things and records from later steps, and nothing in a sound automation', async () => {
    const { session, tasks, people } = await database();
    const schema = session.getSchema();
    const sound = AutomationConfig.parse({
      trigger: { kind: 'recordUpdated', tableId: tasks.id, fieldIds: [tasks.email] },
      conditions: {
        conjunction: 'and',
        conditions: [{ id: 'one', fieldId: tasks.number, operator: 'gt', value: 1 }],
      },
      steps: [
        { id: 'make_one', kind: 'createRecord', tableId: people.id, values: { [people.name]: '{{now}}' } },
        {
          id: 'mail_one',
          kind: 'sendEmail',
          to: [`{{steps.make_one.record.${people.email}}}`],
          subject: `{{trigger.record.${tasks.name}}} {{trigger.record.url}}`,
          body: '',
        },
      ],
    });
    const clean = findProblems(sound, schema);
    expect([clean.trigger.size, clean.conditions.size, clean.steps.size]).toEqual([0, 0, 0]);
    const broken = findProblems(
      AutomationConfig.parse({
        ...sound,
        trigger: { kind: 'schedule', every: { unit: 'day', n: 1 }, at: '09:00', weekday: 1, timeZone: 'UTC' },
        steps: [
          {
            id: 'mail_one',
            kind: 'sendEmail',
            to: [`{{steps.make_one.record.${people.email}}}`],
            subject: '',
            body: '',
          },
          { id: 'make_one', kind: 'createRecord', tableId: people.id, values: {} },
          { id: 'hook_one', kind: 'callWebhook', url: '{{trigger.body.id}}' },
        ],
      }),
      schema,
    );
    expect([...broken.conditions]).toEqual(['missing']);
    expect([...broken.steps.get('mail_one')!]).toEqual(['order']);
    expect(broken.steps.has('make_one')).toBe(false);
    expect([...broken.steps.get('hook_one')!]).toEqual(['missing']);
  });
});
