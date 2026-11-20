import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  anthropicProvider,
  geminiProvider,
  openaiProvider,
  ollamaProvider,
  type ChatRequest,
} from '../index.js';
import { collect, lastBody, startStub, type StubServer } from './harness.test-helpers.js';

let stub: StubServer;
beforeAll(async () => {
  stub = await startStub();
});
afterAll(async () => {
  await stub.stop();
});
const data = randomBytes(24).toString('base64');
const request: ChatRequest = {
  model: 'fixture-vision',
  messages: [
    {
      role: 'user',
      content: 'Read the table',
      attachments: [
        { mediaType: 'image/png', data },
        { mediaType: 'application/pdf', data },
      ],
    },
  ],
};

it('preserves text and inline files in compatible chat requests', async () => {
  stub.handler = async (_request, response) => {
    await response.sse([
      { data: JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) },
      { data: '[DONE]' },
    ]);
  };
  await collect(
    openaiProvider.stream({ apiKey: randomBytes(24).toString('hex'), baseUrl: stub.baseUrl }, request),
  );
  expect(lastBody(stub).messages).toEqual([
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Read the table' },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${data}` } },
        {
          type: 'file',
          file: { filename: 'document.pdf', file_data: `data:application/pdf;base64,${data}` },
        },
      ],
    },
  ]);
});

it('sends images through the local compatible vision endpoint', async () => {
  stub.handler = async (_request, response) => {
    await response.sse([
      { data: JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) },
      { data: '[DONE]' },
    ]);
  };
  await collect(
    ollamaProvider.stream(
      { baseUrl: stub.baseUrl },
      {
        ...request,
        messages: [{ role: 'user', content: 'Read', attachments: [{ mediaType: 'image/png', data }] }],
      },
    ),
  );
  expect(lastBody(stub).messages).toEqual([
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Read' },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${data}` } },
      ],
    },
  ]);
});

it('uses separate image and document blocks in the messages dialect', async () => {
  stub.handler = async (_request, response) => {
    await response.sse([{ data: JSON.stringify({ type: 'message_stop' }) }]);
  };
  await collect(
    anthropicProvider.stream({ apiKey: randomBytes(24).toString('hex'), baseUrl: stub.baseUrl }, request),
  );
  expect(lastBody(stub).messages).toEqual([
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Read the table' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data } },
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } },
      ],
    },
  ]);
});

it('uses inline data parts in the generate content dialect', async () => {
  stub.handler = async (_request, response) => {
    await response.sse([
      { data: JSON.stringify({ candidates: [{ content: { parts: [] }, finishReason: 'STOP' }] }) },
    ]);
  };
  await collect(
    geminiProvider.stream({ apiKey: randomBytes(24).toString('hex'), baseUrl: stub.baseUrl }, request),
  );
  expect(lastBody(stub).contents).toEqual([
    {
      role: 'user',
      parts: [
        { text: 'Read the table' },
        { inlineData: { mimeType: 'image/png', data } },
        { inlineData: { mimeType: 'application/pdf', data } },
      ],
    },
  ]);
});
