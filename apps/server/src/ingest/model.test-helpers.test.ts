import { describe, expect, it, vi } from 'vitest';
import type { ChatMessage, ChatRequest, ProviderAdapter } from '@riosoma/ai';
import { strictStream, validateModelRequest } from './model.test-helpers.js';

const system: ChatMessage = { role: 'system', content: 'Instructions' };
const user: ChatMessage = { role: 'user', content: 'Input' };
const assistant: ChatMessage = {
  role: 'assistant',
  content: '',
  toolCalls: [{ id: 'look', name: 'look', arguments: {} }],
};
const result: ChatMessage = { role: 'tool', toolCallId: 'look', name: 'look', content: '{}' };
const text: ChatMessage = { role: 'assistant', content: 'Finished' };
const request = (...messages: ChatMessage[]): ChatRequest => ({
  model: 'fixture',
  messages,
  tools: [{ name: 'look', description: 'Inspect input', parameters: {} }],
});
const complete = [system, user, assistant, result];

describe.each([
  {
    rule: 'the first message is the system message',
    invalid: request(user, system),
    valid: request(system, user),
  },
  {
    rule: 'there is exactly one system message',
    invalid: request(system, user, system),
    valid: request(system, user),
  },
  {
    rule: 'an assistant turn with empty text carries at least one tool call',
    invalid: request(system, user, { role: 'assistant', content: '', toolCalls: [] }),
    valid: request(...complete),
  },
  {
    rule: 'every tool result matches a call in the nearest earlier assistant turn',
    invalid: request(...complete, text, result),
    valid: request(...complete, text),
  },
  {
    rule: 'every tool result matches a call in the nearest earlier assistant turn',
    invalid: request(system, user, assistant, { ...result, toolCallId: 'missing' }),
    valid: request(...complete),
  },
  {
    rule: 'each tool call is answered at most once',
    invalid: request(...complete, result),
    valid: request(...complete, assistant, result),
  },
  {
    rule: 'no tool result appears before an assistant turn',
    invalid: request(system, user, result),
    valid: request(...complete),
  },
  {
    rule: 'no two assistant turns have unanswered calls between them',
    invalid: request(system, user, assistant, text),
    valid: request(...complete, text),
  },
  {
    rule: 'no two assistant turns have unanswered calls between them',
    invalid: request(
      system,
      user,
      {
        ...assistant,
        toolCalls: [...assistant.toolCalls!, { id: 'second', name: 'look', arguments: {} }],
      },
      result,
      text,
    ),
    valid: request(...complete, text),
  },
  {
    rule: 'every tool named in a call is offered by the request',
    invalid: { ...request(...complete), tools: [] },
    valid: request(...complete),
  },
  {
    rule: 'tool call IDs are unique within an assistant turn',
    invalid: request(system, user, { ...assistant, toolCalls: Array(2).fill(assistant.toolCalls![0]) }),
    valid: request(...complete),
  },
  {
    rule: 'every tool call is answered before the next model request',
    invalid: request(system, user, assistant),
    valid: request(...complete),
  },
])('$rule', ({ rule, invalid, valid }) => {
  it('rejects a broken request and names the rule', () => {
    expect(() => validateModelRequest(invalid)).toThrow(rule);
  });
  it('accepts a valid request', () => {
    expect(() => validateModelRequest(valid)).not.toThrow();
  });
});

it.each(['system', 'user', 'assistant', 'tool'] as const)(
  'rejects null, undefined, and unsupported content on a %s message',
  (role) => {
    for (const content of [null, undefined, 42, [], [{ type: 'text', text: 'Input' }]]) {
      const messages = structuredClone(complete);
      const message = messages.find((entry) => entry.role === role)!;
      Object.assign(message, { content });
      expect(() => validateModelRequest(request(...messages))).toThrow('every message has string content');
    }
    expect(() => validateModelRequest(request(...complete))).not.toThrow();
  },
);

it('accepts the attachment list that adapters turn into multimodal content', () => {
  expect(() =>
    validateModelRequest(
      request(system, {
        ...user,
        attachments: [{ mediaType: 'image/png', data: 'fixture-bytes' }],
      }),
    ),
  ).not.toThrow();
});

it('accepts multiple tool results in a different order from their calls', () => {
  validateModelRequest(
    request(
      system,
      user,
      { ...assistant, toolCalls: [...assistant.toolCalls!, { id: 'second', name: 'look', arguments: {} }] },
      { ...result, toolCallId: 'second' },
      result,
    ),
  );
});

it('accepts adjacent assistant turns when neither has unanswered calls', () => {
  expect(() => validateModelRequest(request(system, user, text, text))).not.toThrow();
});

it('rejects an empty history', () => {
  expect(() => validateModelRequest(request())).toThrow('the first message is the system message');
});

it('checks every request before the scripted stream can answer or fail', async () => {
  const script = vi.fn<ProviderAdapter['stream']>(async function* () {
    yield { type: 'done', stop: 'end' };
  });
  const stream = strictStream(script);
  for (const invalid of [request(user), request(system, { role: 'assistant', content: '' })])
    await expect(stream({}, invalid)[Symbol.asyncIterator]().next()).rejects.toThrow('Invalid model request');
  expect(script).not.toHaveBeenCalled();
  await expect(stream({}, request(system, user))[Symbol.asyncIterator]().next()).resolves.toMatchObject({
    value: { type: 'done', stop: 'end' },
  });
  expect(script).toHaveBeenCalledOnce();
  script.mockImplementationOnce(async function* () {
    yield await Promise.reject(new Error('Fixture provider failure'));
  });
  await expect(stream({}, request(user))[Symbol.asyncIterator]().next()).rejects.toThrow(
    'the first message is the system message',
  );
  expect(script).toHaveBeenCalledOnce();
  await expect(stream({}, request(system, user))[Symbol.asyncIterator]().next()).rejects.toThrow(
    'Fixture provider failure',
  );
});
