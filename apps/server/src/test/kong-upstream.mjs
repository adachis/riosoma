import { createServer } from 'node:http';

// Sent to the Node container with --eval, so this fixture also works with Colima's shared folders.
createServer((request, response) => {
  let body = '';
  request.on('data', (chunk) => {
    body += chunk.toString();
  });
  request.on('end', () => {
    const streamed = JSON.parse(body).stream;
    const message = {
      id: 'fixture-reply',
      object: streamed ? 'chat.completion.chunk' : 'chat.completion',
      created: 1,
      model: 'chat-route',
      choices: [
        {
          index: 0,
          ...(streamed
            ? { delta: { role: 'assistant', content: 'Answer through Kong.' } }
            : { message: { role: 'assistant', content: 'Y' } }),
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 4, completion_tokens: 4, total_tokens: 8 },
    };
    response.setHeader('content-type', streamed ? 'text/event-stream' : 'application/json');
    if (streamed) response.flushHeaders();
    response.end(streamed ? `data: ${JSON.stringify(message)}\n\ndata: [DONE]\n\n` : JSON.stringify(message));
  });
}).listen(8000, '0.0.0.0');
