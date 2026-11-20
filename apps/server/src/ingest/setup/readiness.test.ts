import { describe, expect, it } from 'vitest';
import {
  FieldMeta,
  IngestExample,
  IngestFile,
  IngestFormat,
  IngestTableSettings,
  newId,
} from '@riosoma/contracts';
import { computeReadiness, outputFingerprint, type ReadinessEvidence } from './readiness.js';

const tableId = newId('table');
const fieldId = newId('field');
const date = '2026-10-12T00:00:00.000Z';
function evidence(): ReadinessEvidence {
  return {
    settings: IngestTableSettings.parse({
      state: 'setup',
      ownerId: null,
      rowMeaning: '',
      identity: null,
      fields: [],
      originals: { keepDays: null },
      revision: 1,
    }),
    fields: [],
    formats: [],
    examples: [],
    files: [],
    findings: new Map(),
    signatures: [],
    unavailable: [],
    questions: [],
  };
}
function output(e: ReadinessEvidence) {
  e.fields = [
    {
      ...FieldMeta.parse({
        id: fieldId,
        tableId,
        name: 'Name',
        description: '',
        type: 'text',
        position: 0,
        createdAt: date,
        updatedAt: date,
        ingest: { key: 'name', role: 'data' },
      }),
      columnName: fieldId,
    },
  ];
  e.settings = {
    ...e.settings,
    fields: [{ key: 'name', fieldId, meaning: 'The customer name.', required: true }],
    rowMeaning: 'Each row represents a customer.',
    identity: null,
    identityDecided: true,
  };
}
function pairs(e: ReadinessEvidence, own = true) {
  e.formats = [
    IngestFormat.parse({
      id: 'format',
      orgId: 'org',
      tableId,
      name: 'Receipts',
      state: 'draft',
      signature: { id: 'signature', kind: 'text', headerGroups: [], markers: [] },
      reading: 'ai',
      rules: null,
      probationPassed: 0,
      revision: 1,
      createdBy: null,
      createdAt: date,
      updatedAt: date,
    }),
  ];
  e.files = [1, 2, 3].map((n) =>
    IngestFile.parse({
      id: `file${n}`,
      orgId: 'org',
      tableId,
      parentId: null,
      origin: 'drop',
      name: `${n}.csv`,
      mediaType: 'text/plain',
      sizeBytes: 1,
      sha256: String(n).repeat(64),
      storedFile: `original${n}`,
      senderId: null,
      droppedBy: null,
      receivedAt: date,
      seq: n,
      state: 'received',
      holdReason: null,
      formatId: 'format',
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
  );
  e.examples = e.files.map((file) =>
    IngestExample.parse({
      id: `example${file.seq}`,
      orgId: 'org',
      tableId,
      formatId: 'format',
      fileId: file.id,
      expected: [{ values: { name: 'Customer' } }],
      own,
      confirmedAt: date,
      confirmedBy: null,
      lastResult: null,
    }),
  );
  e.findings = new Map(e.examples.map((example) => [example.id, []]));
}
const gate = (e: ReadinessEvidence, id: string) => computeReadiness(e).gates.find((gate) => gate.id === id)!;
const gap = (messageId: string, facts: Record<string, unknown> = {}) => ({ messageId, facts });

it('returns the exact empty checklist, then becomes ready one gate at a time', () => {
  const e = evidence();
  expect(computeReadiness(e)).toEqual({
    ready: false,
    formats: [],
    gates: [
      { id: 'G1', met: false, gaps: [gap('ingest.ready.noFields')] },
      { id: 'G2', met: false, gaps: [gap('ingest.ready.rowMeaning'), gap('ingest.ready.identity')] },
      { id: 'G3', met: false, gaps: [gap('ingest.ready.noFormat')] },
      { id: 'G4', met: true, gaps: [] },
      { id: 'G5', met: false, gaps: [gap('ingest.ready.noFormat')] },
      { id: 'G6', met: false, gaps: [gap('ingest.ready.noFormat')] },
    ],
  });
  output(e);
  expect(gate(e, 'G1')).toEqual({ id: 'G1', met: true, gaps: [] });
  expect(gate(e, 'G2')).toEqual({ id: 'G2', met: true, gaps: [] });
  pairs(e);
  expect(gate(e, 'G3')).toEqual({ id: 'G3', met: true, gaps: [] });
  expect(gate(e, 'G5').gaps).toEqual([gap('ingest.ready.rules', { format: 'format', count: 0 })]);
  e.examples = e.examples.map((example) => ({ ...example, lastResult: { passed: true, differences: [] } }));
  e.formats = e.formats.map((format) => ({
    ...format,
    checks: { outputFingerprint: outputFingerprint(e.settings, e.fields), formatRevision: format.revision },
  }));
  expect(computeReadiness(e).ready).toBe(true);
  expect(computeReadiness(e).gates.every((gate) => gate.met && !gate.gaps.length)).toBe(true);
});

describe('G1 and G2', () => {
  it('reports missing marks, label meanings, undecided required flags, and choice values exactly', () => {
    const e = evidence();
    output(e);
    e.settings.fields[0]!.meaning = ' NAME ';
    e.settings.fields[0]!.required = undefined as unknown as boolean;
    e.fields = [
      {
        ...e.fields[0]!,
        ingest: undefined,
        type: 'singleSelect',
        options: { choices: [] },
      } as (typeof e.fields)[number],
    ];
    expect(gate(e, 'G1').gaps).toEqual([
      gap('ingest.ready.fieldType', { field: 'name', fieldId }),
      gap('ingest.ready.fieldRequired', { field: 'name', fieldId }),
      gap('ingest.ready.fieldMeaning', { field: 'name', fieldId }),
      gap('ingest.ready.fieldChoices', { field: 'name', fieldId }),
    ]);
    e.settings.rowMeaning = 'Customers';
    e.settings.identityDecided = false;
    expect(gate(e, 'G2').gaps).toEqual([gap('ingest.ready.rowMeaning'), gap('ingest.ready.identity')]);
  });
  it('requires every marked data field in the output format', () => {
    const e = evidence();
    output(e);
    e.settings.fields = [];
    expect(gate(e, 'G1').gaps).toEqual([
      gap('ingest.ready.noFields'),
      gap('ingest.ready.unlistedField', { field: 'name', fieldId }),
    ]);
  });
  it('accepts both identity keys and an explicit no-identity decision', () => {
    const e = evidence();
    output(e);
    expect(gate(e, 'G2').met).toBe(true);
    e.settings.identity = ['name'];
    expect(gate(e, 'G2').met).toBe(true);
  });
});

describe('G3 through G6', () => {
  it('counts distinct hashes and requires an own example', () => {
    const e = evidence();
    output(e);
    pairs(e, false);
    e.files = e.files.map((file) => ({ ...file, sha256: 'a'.repeat(64) }));
    expect(gate(e, 'G3').gaps).toEqual([
      gap('ingest.ready.examples', { format: 'format', count: 1, needed: 3 }),
      gap('ingest.ready.ownExample', { format: 'format' }),
    ]);
  });
  it('reports each incomplete pair and the remaining distinct complete files', () => {
    const e = evidence();
    output(e);
    pairs(e);
    e.findings = new Map([
      [
        'example1',
        [
          {
            kind: 'empty-required',
            messageId: 'ingest.pairs.emptyRequired',
            blocks: true,
            facts: { field: 'name', rows: [1] },
          },
        ],
      ],
      ['example2', []],
      ['example3', []],
    ]);
    expect(gate(e, 'G3').gaps).toEqual([
      gap('ingest.ready.examples', { format: 'format', count: 2, needed: 3 }),
      gap('ingest.ready.incompleteExample', { format: 'format', exampleId: 'example1' }),
    ]);
  });
  it('reports the exact required-value provenance questions', () => {
    const e = evidence();
    output(e);
    pairs(e);
    e.questions = [{ id: 'question', field: 'name' }];
    expect(gate(e, 'G4')).toEqual({
      id: 'G4',
      met: false,
      gaps: [gap('ingest.ready.valueSource', { field: 'name', questionId: 'question' })],
    });
  });
  it('invalidates runs when rules or output definitions change, without invalidating a state change', () => {
    const e = evidence();
    output(e);
    pairs(e);
    e.examples = e.examples.map((example) => ({ ...example, lastResult: { passed: true, differences: [] } }));
    e.formats = [
      {
        ...e.formats[0]!,
        checks: { outputFingerprint: outputFingerprint(e.settings, e.fields), formatRevision: 1 },
      },
    ];
    e.settings = { ...e.settings, state: 'live', ownerId: newId('user'), revision: 99 };
    expect(gate(e, 'G5').met).toBe(true);
    e.settings.fields[0]!.meaning = 'The revised customer name.';
    expect(gate(e, 'G5').gaps).toEqual([gap('ingest.ready.rules', { format: 'format', count: 3 })]);
  });
  it('reports missing own signatures and overlapping signatures exactly', () => {
    const e = evidence();
    output(e);
    pairs(e);
    e.signatures = [
      {
        kind: 'own-signature-missing',
        messageId: 'ingest.pairs.ownSignatureMissing',
        exampleId: 'example1',
        ownFormatId: 'format',
        formatId: 'format',
      },
      {
        kind: 'other-signature-matched',
        messageId: 'ingest.pairs.otherSignatureMatched',
        exampleId: 'example2',
        ownFormatId: 'format',
        formatId: 'other',
      },
    ];
    expect(gate(e, 'G6').gaps).toEqual([
      gap('ingest.pairs.ownSignatureMissing', {
        format: 'format',
        exampleId: 'example1',
        otherFormat: 'format',
      }),
      gap('ingest.pairs.otherSignatureMatched', {
        format: 'format',
        exampleId: 'example2',
        otherFormat: 'other',
      }),
    ]);
  });
  it('reports an unavailable original without counting it as a complete example', () => {
    const e = evidence();
    output(e);
    pairs(e);
    e.unavailable = ['example1'];
    expect(gate(e, 'G6').gaps).toEqual([
      gap('ingest.ready.original', { format: 'format', exampleId: 'example1' }),
    ]);
    expect(gate(e, 'G3').met).toBe(false);
  });
  it('reports unfinished formats without blocking a ready format', () => {
    const e = evidence();
    output(e);
    pairs(e);
    e.examples = e.examples.map((example) => ({ ...example, lastResult: { passed: true, differences: [] } }));
    e.formats = [
      {
        ...e.formats[0]!,
        checks: { outputFingerprint: outputFingerprint(e.settings, e.fields), formatRevision: 1 },
      },
      { ...e.formats[0]!, id: 'unfinished' },
    ];
    const result = computeReadiness(e);
    expect(result.ready).toBe(true);
    expect(result.formats[1]).toEqual({
      formatId: 'unfinished',
      ready: false,
      gaps: [
        gap('ingest.ready.examples', { format: 'unfinished', count: 0, needed: 3 }),
        gap('ingest.ready.ownExample', { format: 'unfinished' }),
        gap('ingest.ready.rules', { format: 'unfinished', count: 0 }),
        gap('ingest.ready.signature', { format: 'unfinished' }),
      ],
    });
  });

  it('chooses a completed format without borrowing another format’s resolved questions', () => {
    const e = evidence();
    output(e);
    pairs(e);
    e.examples = e.examples.map((example) => ({ ...example, lastResult: { passed: true, differences: [] } }));
    const completed = {
      ...e.formats[0]!,
      checks: { outputFingerprint: outputFingerprint(e.settings, e.fields), formatRevision: 1 },
    };
    e.formats = [completed, { ...completed, id: 'alternative' }];
    e.files = [
      ...e.files,
      ...e.files.map((file) => ({
        ...file,
        id: `alternative-${file.id}`,
        formatId: 'alternative',
      })),
    ];
    const alternatives = e.examples.map((example) => ({
      ...example,
      id: `alternative-${example.id}`,
      fileId: `alternative-${example.fileId}`,
      formatId: 'alternative',
    }));
    e.examples = [...e.examples, ...alternatives];
    e.findings = new Map([...e.findings, ...alternatives.map((example) => [example.id, []] as const)]);
    e.questions = [{ id: 'question', field: 'name', formatId: 'format' }];
    const result = computeReadiness(e);
    expect(result.ready).toBe(true);
    expect(result.gates.find((gate) => gate.id === 'G4')).toEqual({ id: 'G4', met: true, gaps: [] });
    expect(result.formats).toEqual([
      {
        formatId: 'format',
        ready: false,
        gaps: [gap('ingest.ready.valueSource', { field: 'name', questionId: 'question' })],
      },
      { formatId: 'alternative', ready: true, gaps: [] },
    ]);
    e.formats = [completed];
    expect(gate(e, 'G4')).toEqual({
      id: 'G4',
      met: false,
      gaps: [gap('ingest.ready.valueSource', { field: 'name', questionId: 'question' })],
    });
  });
});
