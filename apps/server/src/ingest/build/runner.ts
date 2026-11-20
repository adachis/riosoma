import { z } from 'zod';
import type { ChatMessage, ToolCall } from '@riosoma/ai';
import type { IngestBuild, IngestBuildReason, IngestTableSettings } from '@riosoma/contracts';
import {
  LayoutValidationError,
  parseLayout,
  type ExampleResult,
  type ExampleRows,
  type ExtractedSource,
  type FormatDefinition,
  pairValueKey,
} from '@riosoma/ingest';
import { TOOLKIT_VERSION } from '../readers/toolkit-bundle.js';
import type { ReaderFacts } from '../readers/index.js';
import { ReaderBindings } from '../readers/bindings.js';
import { asData } from '../../ai/tools.js';
import { Ask, Empty, Look, Write, buildInstructions, sample } from './tools.js';

export interface BuildExample {
  id: string;
  source: ExtractedSource;
  expected: ExampleRows;
}
export type Draft = Exclude<FormatDefinition, { reading: 'ai' }>;
export interface BuildServices {
  withoutExpectedRows?: boolean;
  checkpoint?: BuildCheckpoint;
  feedback?: () => unknown;
  examples: readonly BuildExample[];
  fields: Pick<IngestTableSettings['fields'][number], 'key' | 'required'>[];
  signal: AbortSignal;
  ceilingUsd: number;
  gate: () => Promise<IngestBuildReason | null>;
  call: (
    messages: ChatMessage[],
    remainingUsd: number,
  ) => Promise<{ calls: ToolCall[]; costUsd: number; reason?: IngestBuildReason }>;
  shown: (id: string) => Promise<void>;
  validateSignature: (draft: Draft) => Promise<boolean>;
  test: (draft: Draft, facts: ReaderFacts) => Promise<Array<{ exampleId: string; result: ExampleResult }>>;
  question: (input: { fieldKey: string; kind: string; choices: string[] }) => Promise<string>;
  answer: (id: string) => Promise<ReaderFacts[string] | undefined>;
  finalize: (
    draft: Draft,
    facts: ReaderFacts,
    results: Array<{ exampleId: string; result: ExampleResult }>,
  ) => Promise<Pick<IngestBuild, 'state' | 'examples' | 'needsExample' | 'offersAi'>>;
  changed: (status: IngestBuild, draft: Draft | null, checkpoint?: BuildCheckpoint) => Promise<void>;
}

export interface BuildCheckpoint {
  draft: Draft | null;
  pending: boolean;
  layoutFailed: boolean;
  facts: ReaderFacts;
  history: ChatMessage[];
  calls: ToolCall[];
}

const readerRules = z.strictObject({
  code: z.string().min(1).max(1_000_000),
  bindings: ReaderBindings.optional(),
});
function suppliesValue(example: BuildExample, fieldKey: string): boolean {
  const cells = [
    ...(example.source.sheets ?? []).flatMap((sheet) =>
      sheet.rows.flatMap((row) => row.map((cell) => cell.v)),
    ),
    ...(example.source.email?.tables ?? []).flat(2),
  ];
  const texts = [
    ...(example.source.pages ?? []).map((page) => page.text),
    ...(example.source.email ? [example.source.email.subject, example.source.email.bodyText] : []),
  ];
  const found = new Set(cells.map((value) => pairValueKey(value)));
  return example.expected.some((row) => {
    const value = row.values[fieldKey];
    if (value === null || value === undefined || value === '') return false;
    return found.has(pairValueKey(value)) || texts.some((text) => text.includes(String(value)));
  });
}
export class BuildCeiling extends Error {}
export class BuildUnavailable extends Error {
  constructor(readonly reason: IngestBuildReason) {
    super(reason);
  }
}

/** This loop has no reference to a blind example, a database connection, or a table record. */
export class BuildRunner {
  private draft: Draft | null = null;
  private pending = false;
  private layoutFailed = false;
  private facts: Record<string, ReaderFacts[string]> = {};
  private results: Array<{ exampleId: string; result: ExampleResult }> = [];
  private history: ChatMessage[];
  private calls: ToolCall[] = [];
  constructor(
    readonly status: IngestBuild,
    private readonly services: BuildServices,
  ) {
    this.history = [
      {
        role: 'system',
        content:
          buildInstructions +
          (services.withoutExpectedRows
            ? '\nStudy one unknown file without expected rows.  A readable draft may have unanswered doubts.  Test reports rows, uncertainty, checks, and missing fields.  Never settle a question yourself.'
            : ''),
      },
      {
        role: 'user',
        content: asData({ fields: services.fields, examples: services.examples.length, untrusted: true }),
      },
    ];
    if (services.checkpoint) {
      const checkpoint = structuredClone(services.checkpoint);
      this.draft = checkpoint.draft;
      this.pending = checkpoint.pending;
      this.layoutFailed = checkpoint.layoutFailed;
      this.facts = checkpoint.facts;
      this.history = checkpoint.history;
      this.calls = checkpoint.calls;
    }
  }

  private async change() {
    this.services.signal.throwIfAborted();
    await this.services.changed(structuredClone(this.status), this.draft && structuredClone(this.draft), {
      draft: this.draft,
      pending: this.pending,
      layoutFailed: this.layoutFailed,
      facts: this.facts,
      history: this.history,
      calls: this.calls,
    });
  }
  private active() {
    return this.status.state === 'running';
  }
  private waiting() {
    return this.status.state === 'waiting';
  }
  private failure() {
    const result = this.results.find((entry) => !entry.result.passed)?.result;
    const diff = result?.differences[0];
    return {
      fieldKey: diff?.key ?? this.services.fields.find((field) => field.required)?.key ?? null,
      kind: diff?.kind ?? result?.failure?.kind ?? 'invalidRules',
      messageId: 'ingest.build.unresolved',
    };
  }
  private async exhausted() {
    if (this.status.attempts < 6) return;
    const unresolved = this.failure();
    this.status.unresolved = unresolved;
    this.status.questionId = await this.services.question({
      fieldKey: unresolved.fieldKey ?? 'rows',
      kind: unresolved.kind,
      choices: ['correctRules', 'correctExample'],
    });
    this.status.state = 'stopped';
    this.status.reason = 'attempts';
    this.status.messageId = 'ingest.build.attempts';
    await this.change();
  }
  private async malformed(messageId: string) {
    // A malformed call consumes its own attempt and cannot leave a previous write ready to test.
    this.pending = false;
    this.status.attempts = Math.min(6, this.status.attempts + 1);
    await this.exhausted();
    await this.change();
    return { messageId };
  }
  async tool(call: ToolCall): Promise<unknown> {
    this.services.signal.throwIfAborted();
    if (!this.active() || (this.status.attempts >= 6 && call.name !== 'test'))
      return { messageId: 'ingest.build.finished' };
    if (call.name === 'look') {
      const input = Look.safeParse(call.arguments);
      const example = input.success ? this.services.examples[input.data.example] : undefined;
      if (!input.success || !example) return this.malformed('ingest.build.invalidTool');
      await this.services.shown(example.id);
      return sample(
        example.source,
        input.data,
        example.expected.slice(input.data.start, input.data.start + input.data.count),
      );
    }
    if (call.name === 'write') {
      if (this.pending) return this.malformed('ingest.build.testRequired');
      this.status.attempts++;
      const input = Write.safeParse(call.arguments);
      if (!input.success) {
        await this.exhausted();
        await this.change();
        return {
          messageId: 'ingest.build.invalidRules',
          errors: input.error.issues.map(({ path, code }) => ({ path, code })),
        };
      }
      try {
        if (input.data.reading === 'reader' && !this.layoutFailed) {
          await this.exhausted();
          await this.change();
          return { messageId: 'ingest.build.layoutFirst' };
        }
        const definition = {
          name: '',
          state: 'draft' as const,
          probationPassed: 0,
          signature: input.data.signature,
        };
        const draft: Draft =
          input.data.reading === 'layout'
            ? { ...definition, reading: 'layout', rules: parseLayout(input.data.rules) }
            : {
                ...definition,
                reading: 'reader',
                rules: {
                  ...readerRules.parse(input.data.rules),
                  toolkitVersion: TOOLKIT_VERSION,
                  anonymousSheets: true,
                },
              };
        const fieldKeys = new Set(this.services.fields.map((field) => field.key));
        const writtenKeys =
          draft.reading === 'layout'
            ? [...Object.keys(draft.rules.columns), ...Object.keys(draft.rules.constants ?? {})]
            : Object.keys(draft.rules.bindings ?? {});
        if (writtenKeys.some((key) => !fieldKeys.has(key))) {
          await this.exhausted();
          await this.change();
          return { messageId: 'ingest.layout.unknownField' };
        }
        if (draft.reading === 'reader') {
          const missing = this.services.withoutExpectedRows
            ? Object.keys(draft.rules.bindings ?? {}).length
              ? []
              : [...fieldKeys]
            : [...fieldKeys].filter((key) => !Object.hasOwn(draft.rules.bindings ?? {}, key));
          if (missing.length) {
            await this.exhausted();
            await this.change();
            return { messageId: 'ingest.build.bindingsRequired', fields: missing.sort() };
          }
        }
        if (!(await this.services.validateSignature(draft))) {
          await this.exhausted();
          await this.change();
          return { messageId: 'ingest.setup.signatureOverlap' };
        }
        this.draft = draft;
        this.pending = true;
        this.status.reading = draft.reading;
        if (draft.reading === 'reader') this.status.readerReason ??= this.failure();
        await this.change();
        return { written: true };
      } catch (error) {
        if (this.services.signal.aborted) throw error;
        await this.exhausted();
        await this.change();
        return {
          messageId: error instanceof LayoutValidationError ? error.issue.key : 'ingest.build.invalidRules',
          ...(error instanceof LayoutValidationError ? { path: error.issue.path } : {}),
        };
      }
    }
    if (call.name === 'test') {
      if (!Empty.safeParse(call.arguments).success || !this.pending || !this.draft)
        return this.malformed('ingest.build.writeRequired');
      this.pending = false;
      this.results = await this.services.test(this.draft, this.facts);
      this.status.examples = this.results.map(({ exampleId, result }) => ({
        exampleId,
        passed: result.passed,
        differenceCount: result.differences.length,
        result: { ...result, differences: result.differences.slice(0, 20) },
      }));
      const passed = this.results.length > 0 && this.results.every(({ result }) => result.passed);
      if (passed) {
        // Finish here without appending any finalization output to model history.
        const reason = await this.services.gate();
        if (reason) {
          this.status.state = 'unavailable';
          this.status.reason = reason;
          this.status.messageId = `ingest.build.${reason}`;
        } else Object.assign(this.status, await this.services.finalize(this.draft, this.facts, this.results));
        if (this.status.state === 'blindFailed') this.status.messageId = 'ingest.build.blindFailed';
        await this.change();
        return { passed: true, ...(this.services.feedback && { study: this.services.feedback() }) };
      }
      if (this.draft.reading === 'layout') this.layoutFailed = true;
      await this.exhausted();
      await this.change();
      return {
        passed: false,
        ...(this.services.feedback && { study: this.services.feedback() }),
        examples: this.status.examples.map(({ result, ...entry }) => ({
          ...entry,
          result: result && {
            ...result,
            failure: result.failure && {
              kind: result.failure.kind,
              messageId: result.failure.messageId,
              reasonId: result.failure.reasonId,
            },
          },
        })),
      };
    }
    if (call.name === 'ask') {
      const input = Ask.safeParse(call.arguments);
      const field = input.success && this.services.fields.find((field) => field.key === input.data.fieldKey);
      if (!input.success || !field) return this.malformed('ingest.build.invalidTool');
      if (input.data.kind === 'valueSource' && !field.required)
        return this.malformed('ingest.build.invalidTool');
      if (
        input.data.kind === 'valueSource' &&
        this.services.examples.some((example) => suppliesValue(example, field.key))
      )
        return this.malformed('ingest.build.valuePresent');
      this.status.questionId = await this.services.question({
        fieldKey: field.key,
        kind: input.data.kind,
        choices:
          input.data.kind === 'valueSource'
            ? ['fixed', 'lookup', 'email', 'person']
            : (input.data.choices ?? ['correctRules', 'correctExample']),
      });
      this.status.state = 'waiting';
      await this.change();
      const answer = await this.services.answer(this.status.questionId);
      this.services.signal.throwIfAborted();
      if (answer === undefined) {
        this.status.state = this.services.withoutExpectedRows ? 'waiting' : 'stopped';
        await this.change();
        return { messageId: 'ingest.build.finished' };
      }
      this.facts[field.key] = answer;
      this.status.state = 'running';
      await this.change();
      return { fieldKey: field.key, fact: answer, untrusted: true };
    }
    return this.malformed('ingest.build.invalidTool');
  }

  async run(): Promise<void> {
    try {
      this.status.state = 'running';
      await this.change();
      // Nonmutating calls are bounded too, so repeated looks cannot run forever on a free model.
      for (let round = 0; round < 80 && this.active(); round++) {
        const reason = await this.services.gate();
        if (reason) {
          this.status.state = 'unavailable';
          this.status.reason = reason;
          this.status.messageId = `ingest.build.${reason}`;
          break;
        }
        if (this.status.spentUsd >= this.services.ceilingUsd) throw new BuildCeiling();
        if (this.calls.length) {
          const call = this.calls[0]!;
          const result = await this.tool(call);
          if (this.services.withoutExpectedRows && this.waiting()) {
            await this.change();
            break;
          }
          this.calls.shift();
          this.history.push({
            role: 'tool',
            toolCallId: call.id,
            name: call.name,
            content: typeof result === 'string' ? result : asData({ data: result, untrusted: true }, 40_000),
          });
          await this.change();
          continue;
        }
        const reply = await this.services.call(
          structuredClone(this.history),
          this.services.ceilingUsd - this.status.spentUsd,
        );
        this.status.spentUsd += reply.costUsd;
        this.services.signal.throwIfAborted();
        if (reply.reason) {
          this.status.state = 'unavailable';
          this.status.reason = reply.reason;
          this.status.messageId = `ingest.build.${reply.reason}`;
          break;
        }
        if (this.status.spentUsd >= this.services.ceilingUsd) throw new BuildCeiling();
        const blocked = await this.services.gate();
        if (blocked) {
          this.status.state = 'unavailable';
          this.status.reason = blocked;
          this.status.messageId = `ingest.build.${blocked}`;
          break;
        }
        if (!reply.calls.length) {
          await this.malformed('ingest.build.invalidTool');
          continue;
        }
        this.history.push({ role: 'assistant', content: '', toolCalls: reply.calls });
        // The work list is consumed as tools run, so it must not be the list the saved turn still needs.
        this.calls = [...reply.calls];
        await this.change();
      }
      if (this.active()) {
        this.status.state = 'stopped';
        this.status.reason = 'noProgress';
        this.status.messageId = 'ingest.build.noProgress';
      }
    } catch (error) {
      if (this.services.signal.aborted) this.status.state = 'canceled';
      else if (error instanceof BuildCeiling) {
        this.status.state = 'ceiling';
        this.status.messageId = 'ingest.build.ceiling';
      } else if (error instanceof BuildUnavailable) {
        this.status.state = 'unavailable';
        this.status.reason = error.reason;
        this.status.messageId = `ingest.build.${error.reason}`;
      } else {
        this.status.state = 'unavailable';
        this.status.reason = 'providerDown';
        this.status.messageId = 'ingest.build.providerDown';
      }
    }
    await this.services.changed(structuredClone(this.status), this.draft, {
      draft: this.draft,
      pending: this.pending,
      layoutFailed: this.layoutFailed,
      facts: this.facts,
      history: this.history,
      calls: this.calls,
    });
  }
}
