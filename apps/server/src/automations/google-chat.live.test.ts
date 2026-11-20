/**
 * A Google Chat post against the real Google Chat.  It runs only when
 * `RIOSOMA_TEST_GOOGLE_CHAT_WEBHOOK_URL` is set (see `test/google-live.ts`), and skips otherwise.
 *
 * Riosoma has no step of its own for Chat, since a Chat space takes a plain https post with a JSON
 * body, which is what the automations' webhook step sends: Chat wants `{"text": "…"}` and answers
 * with the message it made.  A person adds the webhook, since only a person can: in the space, choose
 * Apps, add an incoming webhook, and copy the address it shows.
 *
 * The suite drives a real automation the way a run does: a record created in a throwaway database
 * sets off a webhook step whose body carries that record's own text, and the answer the step recorded
 * has to name the message Chat made.  The message stays in the space, since deleting one needs a scope
 * an incoming webhook never grants.  Nothing here prints the address: the checks quote the step's own
 * output, which carries Chat's answer and never the request.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture } from '../test/fixture.js';
import { TEST_PREFIX, liveChatWebhook } from '../test/google-live.js';
import {
  apply,
  automate,
  createBase,
  createRecords,
  engine,
  runRows,
  type Base,
} from './automations.test-helpers.js';

const webhook = liveChatWebhook();

describe.skipIf(!webhook)('a Google Chat post through the webhook step', () => {
  let kit: TestPostgres;
  let server: ServerFixture;
  let base: Base;

  beforeAll(async () => {
    kit = await startTestPostgres();
    server = await startServer(kit, 'chatlive', { automationsPollMs: 0 });
    base = await createBase(server);
  }, 120_000);

  afterAll(async () => {
    await server?.close();
    await kit?.stop();
  }, 60_000);

  it('posts a message, and the answer names the message Chat made', { timeout: 180_000 }, async () => {
    const text = `${TEST_PREFIX}chat ${randomBytes(4).toString('hex')}`;
    const automationId = await automate(
      server,
      base.databaseId,
      {
        trigger: { kind: 'recordCreated', tableId: base.tasks },
        steps: [
          {
            id: 'post-to-chat',
            kind: 'callWebhook',
            url: webhook!,
            method: 'POST',
            headers: {},
            // The message text comes from the record, the way a run fills it in.
            body: JSON.stringify({ text: `{{trigger.record.${base.f.name}}}` }),
          },
        ],
      },
      { name: 'Google Chat live' },
    );
    await createRecords(server, base.databaseId, base.tasks, [{ [base.f.name]: text }]);
    await engine(server).drain();
    // The automation stops before the checks, so a failure here leaves nothing running.
    await apply(server, base.databaseId, [{ kind: 'automation.update', automationId, enabled: false }]);
    const runs = await runRows(server, automationId);
    expect(runs).toHaveLength(1);
    const run = runs[0]!;
    // A step's output is Chat's answer, so a failure here quotes the answer and nothing else.
    expect(run.state, JSON.stringify(run.steps[0]?.output ?? run.steps[0]?.error)).toBe('succeeded');
    const output = run.steps[0]!.output as { status: number; body: string };
    expect(output.status).toBe(200);
    const answer = JSON.parse(output.body) as { name?: unknown; text?: unknown };
    // Chat answers with the message it made, named after the space it went to.
    expect(answer.name).toMatch(/^spaces\/[^/\s]+\/messages\/[^/\s]+$/);
    // Chat echoes the text of a plain message; a space that cards it answers with the card instead.
    if (typeof answer.text === 'string') expect(answer.text).toBe(text);
  });
});
