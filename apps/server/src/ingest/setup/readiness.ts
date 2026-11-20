import { createHash } from 'node:crypto';
import type {
  IngestExample,
  IngestFile,
  IngestFormat,
  IngestReadiness,
  IngestReadinessGap,
  IngestTableSettings,
} from '@riosoma/contracts';
import type { PairFinding } from '@riosoma/ingest';
import type { StoredField } from '../../data/types.js';
import type { PairSignatureFinding } from '../pairs/index.js';

export interface ReadinessEvidence {
  settings: IngestTableSettings;
  fields: readonly StoredField[];
  formats: readonly Pick<IngestFormat, 'id' | 'revision' | 'checks'>[];
  examples: readonly IngestExample[];
  files: readonly IngestFile[];
  findings: ReadonlyMap<string, readonly PairFinding[]>;
  signatures: readonly PairSignatureFinding[];
  unavailable: readonly string[];
  questions: readonly { id: string; field: string; formatId?: string; fileId?: string }[];
}

export function formatSignatureFindings(findings: readonly PairSignatureFinding[], formatId: string) {
  return findings.filter((finding) => finding.ownFormatId === formatId || finding.formatId === formatId);
}
const gap = (messageId: string, facts: IngestReadinessGap['facts'] = {}): IngestReadinessGap => ({
  messageId,
  facts,
});
// A period, question mark, or exclamation point and multiple words distinguish a sentence from a label.
export const sentence = (text: string) => /\S+\s+\S/.test(text.trim()) && /[.!?]$/.test(text.trim());

export function outputFingerprint(settings: IngestTableSettings, fields: readonly StoredField[]): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        rowMeaning: settings.rowMeaning,
        identity: settings.identity,
        identityDecided: settings.identityDecided,
        fields: settings.fields.map((definition) => {
          const field = fields.find((field) => field.id === definition.fieldId);
          return { ...definition, type: field?.type, options: field?.options };
        }),
      }),
    )
    .digest('hex');
}

/** Both callers use the same gates and the same candidate format, so partial formats cannot combine into readiness. */
export function computeReadiness(evidence: ReadinessEvidence): IngestReadiness {
  const { settings, fields, formats, examples, files } = evidence;
  const g1: IngestReadinessGap[] = [];
  if (!settings.fields.length) g1.push(gap('ingest.ready.noFields'));
  for (const definition of settings.fields) {
    const field = fields.find((field) => field.id === definition.fieldId);
    const facts = { field: definition.key, fieldId: definition.fieldId };
    if (!field?.type || field.ingest?.role !== 'data' || field.ingest.key !== definition.key)
      g1.push(gap('ingest.ready.fieldType', facts));
    if (typeof definition.required !== 'boolean') g1.push(gap('ingest.ready.fieldRequired', facts));
    if (
      !field ||
      !sentence(definition.meaning) ||
      definition.meaning.trim().toLowerCase() === field.name.trim().toLowerCase()
    )
      g1.push(gap('ingest.ready.fieldMeaning', facts));
    if ((field?.type === 'singleSelect' || field?.type === 'multipleSelect') && !field.options.choices.length)
      g1.push(gap('ingest.ready.fieldChoices', facts));
  }
  for (const field of fields.filter((field) => field.ingest?.role === 'data'))
    if (!settings.fields.some((definition) => definition.fieldId === field.id))
      g1.push(gap('ingest.ready.unlistedField', { field: field.ingest!.key, fieldId: field.id }));
  const g2: IngestReadinessGap[] = [];
  if (!sentence(settings.rowMeaning)) g2.push(gap('ingest.ready.rowMeaning'));
  if (!settings.identityDecided) g2.push(gap('ingest.ready.identity'));
  const questions = evidence.questions.map((question) => ({
    ...question,
    formats: new Set([
      ...(question.formatId ? [question.formatId] : []),
      ...files.filter((file) => file.id === question.fileId && file.formatId).map((file) => file.formatId!),
      ...examples.filter((example) => example.fileId === question.fileId).map((example) => example.formatId),
    ]),
  }));
  const questionGaps = (formatId?: string) =>
    questions
      .filter((question) => !question.formats.size || (formatId && question.formats.has(formatId)))
      .map((question) => gap('ingest.ready.valueSource', { field: question.field, questionId: question.id }));
  const candidates = formats.map((format) => {
    const offered = examples.filter((example) => example.formatId === format.id);
    const complete = offered.filter(
      (example) =>
        !evidence.unavailable.includes(example.id) &&
        evidence.findings.has(example.id) &&
        !evidence.findings.get(example.id)!.some((finding) => finding.blocks),
    );
    const hashes = new Set(
      complete
        .map((example) => files.find((file) => file.id === example.fileId)?.sha256)
        .filter((hash) => hash !== undefined),
    );
    const facts = { format: format.id };
    const g3: IngestReadinessGap[] = [];
    if (hashes.size < 3) g3.push(gap('ingest.ready.examples', { ...facts, count: hashes.size, needed: 3 }));
    if (!complete.some((example) => example.own)) g3.push(gap('ingest.ready.ownExample', facts));
    for (const example of offered.filter((example) => !complete.includes(example)))
      g3.push(gap('ingest.ready.incompleteExample', { ...facts, exampleId: example.id }));
    const g4 = questionGaps(format.id);
    const g5: IngestReadinessGap[] = [];
    if (
      !offered.length ||
      offered.some((example) => !example.lastResult?.passed || example.lastResult.differences.length) ||
      format.checks?.outputFingerprint !== outputFingerprint(settings, fields) ||
      format.checks?.formatRevision !== format.revision
    )
      g5.push(
        gap('ingest.ready.rules', {
          ...facts,
          count: offered.filter((example) => example.lastResult?.passed).length,
        }),
      );
    const g6: IngestReadinessGap[] = [];
    if (!offered.length) g6.push(gap('ingest.ready.signature', facts));
    for (const example of offered) {
      if (evidence.unavailable.includes(example.id))
        g6.push(gap('ingest.ready.original', { ...facts, exampleId: example.id }));
    }
    for (const finding of formatSignatureFindings(evidence.signatures, format.id))
      g6.push(
        gap(finding.messageId, {
          ...facts,
          exampleId: finding.exampleId,
          otherFormat: finding.ownFormatId === format.id ? finding.formatId : finding.ownFormatId,
        }),
      );
    return {
      formatId: format.id,
      ready: !g3.length && !g4.length && !g5.length && !g6.length,
      gaps: [...g3, ...g4, ...g5, ...g6],
      g3,
      g4,
      g5,
      g6,
    };
  });
  const chosen = [...candidates].sort(
    (left, right) =>
      Number(right.ready) - Number(left.ready) ||
      left.g3.length - right.g3.length ||
      left.gaps.length - right.gaps.length ||
      left.formatId.localeCompare(right.formatId),
  )[0];
  const g4 = chosen?.g4 ?? questionGaps();
  const gates: IngestReadiness['gates'] = [
    { id: 'G1', met: !g1.length, gaps: g1 },
    { id: 'G2', met: !g2.length, gaps: g2 },
    { id: 'G3', met: chosen?.g3.length === 0, gaps: chosen?.g3 ?? [gap('ingest.ready.noFormat')] },
    { id: 'G4', met: !g4.length, gaps: g4 },
    { id: 'G5', met: chosen?.g5.length === 0, gaps: chosen?.g5 ?? [gap('ingest.ready.noFormat')] },
    { id: 'G6', met: chosen?.g6.length === 0, gaps: chosen?.g6 ?? [gap('ingest.ready.noFormat')] },
  ];
  return {
    ready: gates.every((gate) => gate.met),
    gates,
    formats: candidates.map(({ formatId, ready, gaps }) => ({ formatId, ready, gaps })),
  };
}
