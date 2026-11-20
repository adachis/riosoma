import type { ChatRequest, ProviderAdapter } from '@riosoma/ai';

export function validateModelRequest(request: Pick<ChatRequest, 'messages' | 'tools'>): void {
  const fail = (rule: string, index?: number): never => {
    throw new Error(`Invalid model request: ${rule}${index === undefined ? '' : ` (message ${index})`}`);
  };
  if (request.messages[0]?.role !== 'system') fail('the first message is the system message');
  if (request.messages.filter((message) => message.role === 'system').length !== 1)
    fail('there is exactly one system message');

  const offered = new Set(request.tools?.map((tool) => tool.name));
  let calls = new Set<string>();
  let seenAssistant = false;
  let answered = new Set<string>();
  for (const [index, message] of request.messages.entries()) {
    // Attachments become content lists in adapters, while conversation content remains text.
    if (typeof message.content !== 'string') fail('every message has string content', index);
    if (message.role === 'assistant') {
      if (!message.content && !message.toolCalls?.length)
        fail('an assistant turn with empty text carries at least one tool call', index);
      if (answered.size !== calls.size)
        fail('no two assistant turns have unanswered calls between them', index);
      seenAssistant = true;
      calls = new Set();
      answered = new Set();
      for (const call of message.toolCalls ?? []) {
        if (!offered.has(call.name)) fail('every tool named in a call is offered by the request', index);
        if (calls.has(call.id)) fail('tool call IDs are unique within an assistant turn', index);
        calls.add(call.id);
      }
    } else if (message.role === 'tool') {
      if (!seenAssistant) fail('no tool result appears before an assistant turn', index);
      if (!calls.has(message.toolCallId))
        fail('every tool result matches a call in the nearest earlier assistant turn', index);
      if (answered.has(message.toolCallId)) fail('each tool call is answered at most once', index);
      answered.add(message.toolCallId);
    }
  }
  if (answered.size !== calls.size) fail('every tool call is answered before the next model request');
}

export function strictStream(script: ProviderAdapter['stream']): ProviderAdapter['stream'] {
  return async function* (config, request) {
    validateModelRequest(request);
    yield* script(config, request);
  };
}
