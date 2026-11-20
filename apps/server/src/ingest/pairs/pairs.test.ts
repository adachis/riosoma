import ExcelJS from 'exceljs';
import { describe, expect, it, vi } from 'vitest';
import {
  IngestExample,
  IngestExampleResult,
  IngestFile,
  IngestFormat,
  IngestTableSettings,
  newId,
} from '@riosoma/contracts';
import { ARCHETYPES, generateArchetype, interpretLayout, type ArchetypeId } from '@riosoma/ingest';
import type { IngestActor, StoredIngestFormat } from '../tables/store.js';
import { failed as extractionFailed } from '../extract/types.js';
import { checkPairSignatures, pairFieldType, runFormatPairs, type PairRunnerServices } from './index.js';

const time = '2026-10-12T00:00:00.000Z';

async function fixture(id: ArchetypeId = 1, count = 3, originalBytes = false) {
  const corpus = Array.from({ length: count }, (_, index) =>
    generateArchetype(id, { seed: 20 + index, size: 4 }),
  );
  corpus.forEach((example, index) => {
    example.source.name = `pair-${index}.xlsx`;
  });
  const actor: IngestActor = { orgId: 'pair-test-org', tableId: newId('table'), userId: null };
  const ingest = IngestTableSettings.parse({
    state: 'setup',
    ownerId: null,
    rowMeaning: 'One record',
    identity: id === 1 || id === 4 ? ['id'] : id === 3 ? ['id', 'period'] : null,
    fields: [
      ...new Set(corpus.flatMap((example) => example.expected.flatMap((row) => Object.keys(row.values)))),
    ].map((key) => ({ key, fieldId: newId('field'), meaning: key, required: true })),
    originals: { keepDays: 'forever' },
    revision: 1,
  });
  const table = { id: actor.tableId, ingest };
  const format: StoredIngestFormat = {
    ...IngestFormat.parse({
      orgId: actor.orgId,
      tableId: actor.tableId,
      id: 'format',
      name: 'Orders',
      state: 'draft',
      signature: corpus[0]!.signature,
      reading: 'layout',
      rules: corpus[0]!.layout,
      probationPassed: 0,
      revision: 1,
      createdBy: null,
      createdAt: time,
      updatedAt: time,
    }),
    reading: 'layout',
    rules: corpus[0]!.layout!,
  };
  const examples = corpus.map((example, index) =>
    IngestExample.parse({
      orgId: actor.orgId,
      tableId: actor.tableId,
      id: `example-${index}`,
      formatId: format.id,
      fileId: `file-${index}`,
      expected: example.expected.map((row) => ({ values: row.values })),
      own: true,
      confirmedAt: time,
      confirmedBy: null,
      lastResult: null,
    }),
  );
  const files = new Map(
    examples.map((example, index) => [
      example.fileId,
      IngestFile.parse({
        orgId: actor.orgId,
        tableId: actor.tableId,
        id: example.fileId,
        parentId: null,
        origin: 'drop',
        name: corpus[index]!.source.name,
        mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        sizeBytes: 1,
        sha256: String(index).repeat(64),
        storedFile: `original-${index}`,
        senderId: null,
        droppedBy: null,
        receivedAt: time,
        seq: index,
        state: 'received',
        holdReason: null,
        formatId: format.id,
        counts: { added: 0, updated: 0, identical: 0, flagged: 0, refused: 0 },
        notes: [],
        checks: {},
        expiresAt: null,
        isExample: true,
        attempts: 0,
        leaseUntil: null,
        leasedBy: null,
        nextAttemptAt: null,
      }),
    ]),
  );
  const bytes = new Map<string, Uint8Array>();
  for (const [index, example] of corpus.entries()) {
    if (originalBytes) {
      const book = new ExcelJS.Workbook();
      for (const source of example.source.sheets ?? []) {
        const sheet = book.addWorksheet(source.name, { state: source.hidden ? 'hidden' : 'visible' });
        sheet.addRows(source.rows.map((row) => row.map((item) => item.v)));
        for (const merge of source.merges ?? [])
          sheet.mergeCells(merge.top, merge.left, merge.bottom, merge.right);
      }
      bytes.set(`original-${index}`, new Uint8Array(await book.xlsx.writeBuffer()));
    } else bytes.set(`original-${index}`, new Uint8Array([index]));
  }
  const saved = new Map<string, IngestExample>();
  const services: PairRunnerServices = {
    actor,
    fieldTypes: {},
    store: {
      readFile: vi.fn(async (_context, fileId) => files.get(fileId) ?? null),
      updateExample: vi.fn(async (_context, exampleId, patch) => {
        const before = examples.find((example) => example.id === exampleId)!;
        const after = IngestExample.parse({ ...before, ...JSON.parse(JSON.stringify(patch)) });
        saved.set(exampleId, after);
        return after;
      }),
    },
    loadOriginal: vi.fn(async (file) => bytes.get(file.storedFile!) ?? null),
    now: () => new Date(time),
    ...(!originalBytes
      ? {
          extract: vi.fn(async (_name: string, bytes: Uint8Array) => ({
            status: 'extracted' as const,
            sniffedType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            source: structuredClone(corpus[bytes[0]!]!.source),
          })),
        }
      : {}),
  };
  return { table, format, examples, services, files, bytes, saved, corpus };
}

describe('format pair runner', () => {
  for (const archetype of ARCHETYPES.filter((archetype) => archetype.layout))
    it(`extracts and passes three stored workbook pairs for archetype ${archetype.id}, then names one changed cell`, async () => {
      const setup = await fixture(archetype.id, 3, true);
      const { table, format, examples, services, saved } = setup;
      const passed = await runFormatPairs(table, format, examples, services);
      expect(passed.passed).toBe(true);
      expect(passed.examples).toHaveLength(3);
      for (const { exampleId, result } of passed.examples) {
        expect(result).toMatchObject({ passed: true, status: 'passed', differences: [] });
        expect(saved.get(exampleId)?.lastResult).toEqual(result);
      }
      examples[1]!.expected[1]!.values.amount = 'changed-amount';
      const failed = await runFormatPairs(table, format, examples, services);
      expect(failed.passed).toBe(false);
      expect(failed.examples.map(({ result }) => result.passed)).toEqual([true, false, true]);
      expect(failed.examples[1]!.result.differences).toEqual([
        expect.objectContaining({
          kind: 'cell',
          key: 'amount',
          expectedPosition: 1,
          actualPosition: 1,
          expected: 'changed-amount',
          actual: setup.corpus[1]!.expected[1]!.values.amount,
        }),
      ]);
      expect(saved.get(examples[1]!.id)?.lastResult).toEqual(failed.examples[1]!.result);
      expect(services.loadOriginal).toHaveBeenCalledTimes(6);
    });

  it.each(['reader', 'ai'] as const)(
    'saves a typed cannot-run-yet result for %s when its callback is absent',
    async (reading) => {
      const { table, format, examples, services, saved } = await fixture();
      const unavailable: StoredIngestFormat =
        reading === 'reader'
          ? { ...format, reading, rules: { code: 'read', toolkitVersion: '1' } }
          : { ...format, reading, rules: null };
      const result = await runFormatPairs(table, unavailable, examples, services);
      expect(result.passed).toBe(false);
      for (const outcome of result.examples) {
        expect(outcome.result).toEqual({
          passed: false,
          status: 'cannot-run-yet',
          differences: [],
          failure: { kind: 'cannot-run-yet', messageId: 'ingest.pairs.cannotRunYet' },
        });
        expect(saved.get(outcome.exampleId)?.lastResult).toEqual(outcome.result);
      }
      expect(services.loadOriginal).not.toHaveBeenCalled();
    },
  );

  it('uses an injected reader with the format and output settings', async () => {
    const { table, format, examples, services } = await fixture();
    services.readWithReader = vi.fn((source, receivedFormat, output) => {
      expect(receivedFormat.reading).toBe('reader');
      expect(output).toEqual(table.ingest);
      const result = interpretLayout(source, format.rules);
      if (!result.ok) throw new Error('invalid fixture');
      return result.rows;
    });
    expect(
      (
        await runFormatPairs(
          table,
          { ...format, reading: 'reader', rules: { code: 'read', toolkitVersion: '1' } },
          examples,
          services,
        )
      ).passed,
    ).toBe(true);
    expect(services.readWithReader).toHaveBeenCalledTimes(3);
  });

  it.each([
    'expired',
    'expired-reference',
    'boundary',
    'missing-file',
    'missing-reference',
    'missing-bytes',
    'storage-error',
    'extract-error',
    'extract-failure',
    'password',
    'layout-failure',
    'reader-failure',
    'save-error',
  ] as const)(
    'contains %s in one pair, preserves its reason, and continues to the next pair',
    async (scenario) => {
      const { table, examples, services, files, bytes, saved, corpus, format: original } = await fixture();
      let format: StoredIngestFormat = original;
      const first = files.get(examples[0]!.fileId)!;
      let failure: string;
      if (scenario === 'expired' || scenario === 'expired-reference' || scenario === 'boundary') {
        first.expiresAt = scenario === 'expired' ? '2026-10-11T23:59:59.000Z' : time;
        if (scenario === 'expired-reference') first.storedFile = null;
        failure = 'original-expired';
      } else if (scenario === 'missing-file') {
        files.delete(first.id);
        failure = 'original-unavailable';
      } else if (scenario === 'missing-reference') {
        first.storedFile = null;
        failure = 'original-unavailable';
      } else if (scenario === 'missing-bytes') {
        bytes.delete(first.storedFile!);
        failure = 'original-unavailable';
      } else if (scenario === 'storage-error') {
        vi.mocked(services.loadOriginal).mockRejectedValueOnce(new Error('storage detail'));
        failure = 'original-unavailable';
      } else if (scenario === 'extract-error') {
        vi.mocked(services.extract!).mockRejectedValueOnce(new Error('extraction detail'));
        failure = 'extraction-failed';
      } else if (scenario === 'extract-failure' || scenario === 'password') {
        vi.mocked(services.extract!).mockResolvedValueOnce(
          scenario === 'password'
            ? {
                status: 'needs-password',
                messageKey: 'ingest.extract.needsPassword',
                sniffedType: 'application/pdf',
              }
            : extractionFailed('invalid'),
        );
        failure = 'extraction-failed';
      } else if (scenario === 'layout-failure') {
        corpus[0]!.source.sheets![0]!.rows = [];
        failure = 'read-failed';
      } else if (scenario === 'reader-failure') {
        format = { ...original, reading: 'reader', rules: { code: 'read', toolkitVersion: '1' } };
        services.readWithReader = vi.fn((source) => {
          if (source.name === corpus[0]!.source.name) throw new Error('private implementation detail');
          const result = interpretLayout(source, original.rules);
          return result.ok ? result.rows : [];
        });
        failure = 'read-failed';
      } else {
        vi.mocked(services.store.updateExample).mockRejectedValueOnce(new Error('save detail'));
        failure = 'save-failed';
      }
      const result = await runFormatPairs(table, format, examples, services);
      expect(result.passed).toBe(false);
      expect(result.examples.map(({ result }) => result.passed)).toEqual([false, true, true]);
      expect(result.examples[0]!.result.failure?.kind).toBe(failure);
      expect(result.examples[0]!.result.status).toBe('failed');
      if (scenario !== 'save-error')
        expect(saved.get(examples[0]!.id)?.lastResult).toEqual(result.examples[0]!.result);
      if (scenario === 'extract-failure')
        expect(result.examples[0]!.result.failure?.reasonId).toBe('ingest.extract.invalid');
      if (scenario === 'password')
        expect(result.examples[0]!.result.failure?.reasonId).toBe('ingest.extract.needsPassword');
      if (scenario === 'layout-failure')
        expect(result.examples[0]!.result.failure?.reasonId).toBe('ingest.layout.headerNotFound');
      expect(JSON.stringify(result)).not.toContain('private implementation detail');
      expect(saved.get(examples[2]!.id)?.lastResult?.passed).toBe(true);
    },
  );

  it('runs an expired pair whose original is still within its lifetime', async () => {
    const { table, format, examples, services, files } = await fixture();
    files.get(examples[0]!.fileId)!.expiresAt = '2026-10-12T00:00:00.001Z';
    expect((await runFormatPairs(table, format, examples, services)).passed).toBe(true);
  });

  it.each([0, 1, 2] as const)('requires two exact runs and identifies failing run %s', async (badRun) => {
    const { table, format, examples, services, corpus, saved } = await fixture();
    const counts = new Map<string, number>();
    services.readWithAi = vi.fn((source) => {
      const run = (counts.get(source.name) ?? 0) + 1;
      counts.set(source.name, run);
      const reading = interpretLayout(source, format.rules);
      if (!reading.ok) throw new Error('invalid fixture');
      if (source.name === corpus[1]!.source.name && run === badRun) reading.rows[0]!.values.amount = 'wrong';
      return reading.rows;
    });
    const result = await runFormatPairs(table, { ...format, reading: 'ai', rules: null }, examples, services);
    expect(result.passed).toBe(badRun === 0);
    expect(services.readWithAi).toHaveBeenCalledTimes(examples.length * 2);
    for (const outcome of result.examples) {
      expect(outcome.result.runs?.map((run) => run.run)).toEqual([1, 2]);
      expect(saved.get(outcome.exampleId)?.lastResult).toEqual(outcome.result);
      expect(IngestExampleResult.parse(outcome.result)).toEqual(outcome.result);
    }
    if (badRun) {
      expect(result.examples[1]!.result.runs?.map((run) => run.passed)).toEqual(
        badRun === 1 ? [false, true] : [true, false],
      );
      expect(result.examples[1]!.result.differences).toEqual([
        expect.objectContaining({ run: badRun, key: 'amount' }),
      ]);
    }
  });

  it('runs every pair twice even when a reading throws, and records the failed run', async () => {
    const { table, format, examples, services, corpus } = await fixture();
    const counts = new Map<string, number>();
    services.readWithAi = vi.fn((source) => {
      const run = (counts.get(source.name) ?? 0) + 1;
      counts.set(source.name, run);
      if (source.name === corpus[0]!.source.name && run === 2) throw new Error('unreadable');
      const reading = interpretLayout(source, format.rules);
      return reading.ok ? reading.rows : [];
    });
    const result = await runFormatPairs(table, { ...format, reading: 'ai', rules: null }, examples, services);
    expect(result.examples.map(({ result }) => result.passed)).toEqual([false, true, true]);
    expect(result.examples[0]!.result.failure).toMatchObject({ kind: 'read-failed', run: 2 });
    expect(services.readWithAi).toHaveBeenCalledTimes(6);
  });

  it('isolates input, rules, and output settings between injected readings', async () => {
    const { table, format, examples, services, corpus } = await fixture();
    const before = JSON.stringify({ table, format, corpus });
    services.readWithAi = vi.fn((source, rules, output) => {
      const reading = interpretLayout(source, format.rules);
      source.sheets = [];
      output.fields = [];
      rules.name = 'Changed';
      return reading.ok ? reading.rows : [];
    });
    expect(
      (await runFormatPairs(table, { ...format, reading: 'ai', rules: null }, examples, services)).passed,
    ).toBe(true);
    expect(JSON.stringify({ table, format, corpus })).toBe(before);
  });

  it('refuses mismatched table context and does not pass a format with no pairs', async () => {
    const { table, format, examples, services } = await fixture();
    const result = await runFormatPairs({ ...table, id: newId('table') }, format, examples, services);
    expect(result.examples.every(({ result }) => result.failure?.kind === 'invalid-context')).toBe(true);
    expect(services.loadOriginal).not.toHaveBeenCalled();
    expect(await runFormatPairs(table, format, [], services)).toEqual({ passed: false, examples: [] });
  });
});

describe('pair signature checks', () => {
  const shapes = [1, 2, 3, 4].map((id) => generateArchetype(id as ArchetypeId, { size: 4, seed: 20 }));
  const formats = shapes.map((example) => ({
    id: `format-${example.id}`,
    signature: { ...example.signature, id: 'shared-signature-id' },
  }));
  const examples = shapes.map((example) => ({
    id: `example-${example.id}`,
    formatId: `format-${example.id}`,
    source: example.source,
  }));

  it('accepts each own signature and rejects all cross-format matches regardless of score', () => {
    expect(checkPairSignatures(formats, examples)).toEqual([]);
    const broad = { id: 'broad', signature: { ...formats[0]!.signature, headerGroups: [], markers: [] } };
    const findings = checkPairSignatures([...formats, broad], examples);
    expect(findings).toHaveLength(4);
    expect(findings[0]).toMatchObject({
      kind: 'other-signature-matched',
      messageId: 'ingest.pairs.otherSignatureMatched',
      exampleId: 'example-1',
      ownFormatId: 'format-1',
      formatId: 'broad',
    });
    expect(checkPairSignatures([broad, ...formats].reverse(), [...examples].reverse())).toEqual(findings);
  });

  it('names an example whose own signature no longer matches or whose format is absent', () => {
    const changed = formats.map((format, index) =>
      index === 0 ? { ...format, signature: { ...format.signature, markers: ['Missing marker'] } } : format,
    );
    expect(checkPairSignatures(changed, examples)).toEqual([
      {
        kind: 'own-signature-missing',
        messageId: 'ingest.pairs.ownSignatureMissing',
        exampleId: 'example-1',
        ownFormatId: 'format-1',
        formatId: 'format-1',
      },
    ]);
    expect(checkPairSignatures(formats.slice(1), examples)).toEqual([
      {
        kind: 'own-signature-missing',
        messageId: 'ingest.pairs.ownSignatureMissing',
        exampleId: 'example-1',
        ownFormatId: 'format-1',
        formatId: 'format-1',
      },
    ]);
  });
});

it('compares only number, date, and checkbox fields by value, and everything else as text', () => {
  expect(
    ['number', 'currency', 'percent', 'duration', 'rating'].map((type) => pairFieldType({ type })),
  ).toEqual(['number', 'number', 'number', 'number', 'number']);
  expect(pairFieldType({ type: 'checkbox' })).toBe('boolean');
  expect(pairFieldType({ type: 'date', options: { includeTime: false } })).toBe('date');
  expect(pairFieldType({ type: 'date', options: { includeTime: true } })).toBe('dateTime');
  expect(pairFieldType({ type: 'date' })).toBe('date');
  // Identifiers, names, choices, links, and anything unknown keep their text exactly.
  for (const type of ['text', 'longText', 'singleSelect', 'link', 'phone', 'url', 'email', 'unknown'])
    expect(pairFieldType({ type })).toBe('text');
});
