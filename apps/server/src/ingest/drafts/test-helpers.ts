import { schemaOutput, type ChatRequest, type ProviderAdapter } from '@riosoma/ai';
import type { createAiReader } from '../ai-reader/index.js';
import { readFileWithAi } from '../ai-reader/reader.js';
import type { ChunkReply } from '../ai-reader/schema.js';
import { strictStream } from '../model.test-helpers.js';

export const draftRequests: ChatRequest[] = [];
export function createScriptedDraftRead(forcedToolChoice = true): ReturnType<typeof createAiReader> {
  const adapter: ProviderAdapter = {
    id: 'draft-fixture',
    name: 'Draft fixture',
    local: true,
    listModels: async () => [],
    supportsForcedToolChoice: () => forcedToolChoice,
    stream: strictStream(async function* (_config, request) {
      draftRequests.push(structuredClone(request));
      const { chunk } = JSON.parse(request.messages[1]!.content).data as {
        chunk: { sheet: number; rows: Array<{ row: number; cells: string[] }> };
      };
      const rows: ChunkReply['rows'] = chunk.rows
        .filter((row) => row.row > 1 && row.cells[0])
        .map((row) => ({
          values: { name: row.cells[0], amount: Number(row.cells[1]), day: row.cells[2] },
          at: { sheet: chunk.sheet, row: row.row },
          sources: { name: row.cells[0]!, amount: row.cells[1]!, day: row.cells[2]! },
          doubts: row.row === 11 ? ['day'] : [],
        }));
      const value: ChunkReply = { count: rows.length, rows, emptyReason: rows.length ? null : 'headings' };
      if (forcedToolChoice)
        yield { type: 'toolCallInput', name: 'submit_output', input: { value }, encoding: 'value' };
      else yield { type: 'text', delta: JSON.stringify(value) };
      yield { type: 'usage', inputTokens: 100, outputTokens: 50 };
      yield { type: 'done', stop: forcedToolChoice ? 'toolCalls' : 'end' };
    }),
  };

  return async (source, format, table, previousChecks, checkpoint) =>
    readFileWithAi(
      source,
      format,
      {
        rowMeaning: table.ingest!.rowMeaning,
        identity: table.ingest!.identity,
        fields: table.ingest!.fields.map((field) => ({
          key: field.key,
          type: field.key === 'amount' ? 'number' : field.key === 'day' ? 'date' : 'text',
          meaning: field.meaning,
          required: field.required,
        })),
      },
      {
        ceilingUsd: 1,
        price: { input: 1, output: 2 },
        guard: async () => null,
        previousChecks,
        checkpoint,
        request: async (schema, request) => ({
          ...(await schemaOutput(adapter, {}, schema, { ...request, model: 'draft-fixture' })),
          costUsd: 0.03,
        }),
      },
    );
}

export const scriptedDraftRead = createScriptedDraftRead();
