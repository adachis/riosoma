import { execFile, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { GatewayConfig, type RioConversation } from '@riosoma/contracts';
import { startTestPostgres } from '@riosoma/testkit';
import { prepareContainerImage } from '../test/container-image.js';
import { startServer } from '../test/fixture.js';

const run = promisify(execFile);
const dockerAvailable = (() => {
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore', timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
})();

it.skipIf(!dockerAvailable).for([true, false])(
  'Rio tests Kong OSS with an enlarged request buffer: %s',
  { timeout: 180_000 },
  async (enlargedBuffer, context) => {
    const prefix = `ai-gateway-provider-${process.pid}-${Date.now()}`;
    const baseImage = process.env.RIOSOMA_TEST_KONG_IMAGE ?? 'kong:3.9';
    const upstreamImage = 'node:24-alpine';
    for (const image of [baseImage, upstreamImage]) {
      const preparation = await prepareContainerImage(image, (args, options) => run('docker', args, options));
      if (preparation.action === 'skip') {
        context.skip(preparation.reason);
        return;
      }
    }
    const gatewayKey = randomUUID();
    const upstreamKey = randomUUID();
    let kit: Awaited<ReturnType<typeof startTestPostgres>> | undefined;
    let server: Awaited<ReturnType<typeof startServer>> | undefined;
    try {
      // Keep Kong's upstream off the host: Linux firewalls can drop bridge-to-host connections,
      // even when Docker's published Kong port is reachable from the host.
      await run('docker', ['network', 'create', prefix]);
      await run('docker', [
        'run',
        '-d',
        '--name',
        `${prefix}-upstream`,
        '--network',
        prefix,
        '--network-alias',
        'upstream',
        upstreamImage,
        'node',
        '--input-type=module',
        '--eval',
        await readFile(new URL('../test/kong-upstream.mjs', import.meta.url), 'utf8'),
      ]);
      // Passed inline as JSON: Docker hosts that share only the home folder (Colima) can't mount a
      // temp file, and Kong reads an inline declarative config only as JSON.
      const upstreamUrl = 'http://upstream:8000';
      const kongConfig = JSON.stringify({
        _format_version: '3.0',
        services: [
          {
            name: 'conversation',
            url: upstreamUrl,
            routes: [
              {
                name: 'conversation',
                paths: ['/rio/v1/chat/completions'],
                plugins: [
                  { name: 'key-auth' },
                  {
                    name: 'ai-proxy',
                    config: {
                      route_type: 'llm/v1/chat',
                      auth: { header_name: 'Authorization', header_value: `Bearer ${upstreamKey}` },
                      model: {
                        provider: 'openai',
                        name: 'chat-route',
                        options: { upstream_url: `${upstreamUrl}/v1/chat/completions` },
                      },
                    },
                  },
                ],
              },
            ],
          },
        ],
        consumers: [{ username: 'rio', keyauth_credentials: [{ key: gatewayKey }] }],
      });
      await run('docker', ['tag', baseImage, prefix]);
      await run('docker', [
        'run',
        '-d',
        '--name',
        prefix,
        '--network',
        prefix,
        '-p',
        '127.0.0.1::8000',
        '-e',
        'KONG_DATABASE=off',
        '-e',
        `KONG_DECLARATIVE_CONFIG_STRING=${kongConfig}`,
        '-e',
        'KONG_ADMIN_LISTEN=off',
        // Kong's AI proxy reads only bodies within the request buffer (8 KB by default), and Rio's
        // requests with their tools are larger, so gateways in front of Rio need a bigger buffer.
        ...(enlargedBuffer ? ['-e', 'KONG_NGINX_HTTP_CLIENT_BODY_BUFFER_SIZE=1m'] : []),
        prefix,
      ]);
      const { stdout } = await run('docker', ['port', prefix, '8000/tcp']);
      const address = `http://${stdout.trim()}`;
      await expect
        .poll(
          async () => {
            try {
              const response = await fetch(`${address}/rio/v1/chat/completions`, {
                signal: AbortSignal.timeout(1_000),
              });
              await response.body?.cancel();
              return `HTTP ${response.status}`;
            } catch (error) {
              const detail = error instanceof Error ? error.message : String(error);
              const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : '';
              return `Connection error: ${detail}${cause ? ` (${cause})` : ''}`;
            }
          },
          { timeout: 30_000 },
        )
        .toBe('HTTP 401');
      // This small request fits the default buffer, so both cases must reach the upstream.
      await expect
        .poll(
          async () => {
            try {
              const response = await fetch(`${address}/rio/v1/chat/completions`, {
                method: 'POST',
                headers: { apikey: gatewayKey, 'content-type': 'application/json' },
                body: JSON.stringify({
                  model: 'chat-route',
                  messages: [{ role: 'user', content: '.' }],
                  stream: false,
                }),
                signal: AbortSignal.timeout(1_000),
              });
              return { status: response.status, body: await response.json() };
            } catch (error) {
              return error instanceof Error ? error.message : String(error);
            }
          },
          { timeout: 10_000, message: `Kong must reach the fixture upstream at ${upstreamUrl}` },
        )
        .toMatchObject({ status: 200, body: { choices: [{ message: { content: 'Y' } }] } });
      kit = await startTestPostgres();
      server = await startServer(kit, 'gateway_kong');
      const send = (method: 'PUT' | 'POST', url: string, payload: unknown) =>
        server!.app.inject({
          method,
          url,
          headers: server!.owner.headers,
          payload: payload as Record<string, unknown>,
        });
      const gateway = GatewayConfig.parse({
        providerId: 'gateway-kong',
        name: 'Kong',
        baseUrl: `${address}/rio/v1`,
        auth: { mode: 'header', header: 'apikey' },
        models: [{ model: 'chat-route', contextTokens: 32_000 }],
      });
      const saved = await send('PUT', '/api/ai/gateways/gateway-kong', { gateway, key: gatewayKey });
      expect(saved.statusCode, saved.body).toBe(200);
      const tested = (await send('POST', '/api/ai/test', { providerId: 'gateway-kong' })).json();
      if (!enlargedBuffer) {
        expect(tested).toEqual({ success: false, messageKey: 'ai.gateway.requestBufferTooSmall' });
        return;
      }
      expect(tested).toMatchObject({ success: true, roundTripMs: expect.any(Number) });
      await send('PUT', '/api/ai/settings', { enabled: true });
      const conversation = (await send('POST', '/api/rio/conversations', {})).json<RioConversation>();
      const answer = await send('POST', `/api/rio/conversations/${conversation.id}/messages`, {
        text: 'Hello',
        locale: 'en-US',
      });
      expect(answer.body).toContain('Answer through Kong.');
      await send('PUT', '/api/ai/gateways/gateway-kong', { gateway, key: randomUUID() });
      expect((await send('POST', '/api/ai/test', { providerId: 'gateway-kong' })).json()).toEqual({
        success: false,
        messageKey: 'ai.gateway.rejectedKey',
      });
    } finally {
      await server?.close();
      await kit?.stop();
      await run('docker', ['rm', '-f', prefix, `${prefix}-upstream`]).catch(() => undefined);
      await run('docker', ['network', 'rm', prefix]).catch(() => undefined);
      await run('docker', ['image', 'rm', prefix]).catch(() => undefined);
    }
  },
);
