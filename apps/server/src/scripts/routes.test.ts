import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  newId,
  type DatabaseSchema,
  type DatabaseTrash,
  type ScriptClientMessage,
  type ScriptServerMessage,
  type UndoResult,
} from '@riosoma/contracts';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture, type SignedIn } from '../test/fixture.js';
import { PANEL_RUNS } from './routes.js';
import { apply, saveScript, scriptBase, send, type ScriptBase } from './scripts.test-helpers.js';

let kit: TestPostgres;
let server: ServerFixture;
let base: ScriptBase;
let address: string;
const sockets: PanelSocket[] = [];

beforeAll(async () => {
  kit = await startTestPostgres();
  server = await startServer(kit, 'scriptsock', { automationsPollMs: 0 });
  server.config.baseUrl = undefined;
  address = await server.app.listen({ host: '127.0.0.1', port: 0 });
  base = await scriptBase(server);
}, 60_000);

afterEach(async () => {
  await Promise.all(sockets.splice(0).map((socket) => socket.close()));
});

afterAll(async () => {
  await server?.close();
  await kit?.stop();
});

async function until(check: () => boolean, timeout = 10_000): Promise<void> {
  const started = performance.now();
  while (!check()) {
    if (performance.now() - started > timeout) throw new Error('condition timed out');
    await delay(10);
  }
}

/** A script panel's run socket, as the browser opens it */
class PanelSocket {
  readonly socket: WebSocket;
  readonly inbox: ScriptServerMessage[] = [];
  readonly opened: Promise<void>;
  readonly closed: Promise<number>;

  constructor(scriptId: string, who: SignedIn, origin = new URL(address).origin) {
    this.socket = new WebSocket(`${address.replace(/^http/, 'ws')}/api/scripts/${scriptId}/run`, {
      headers: { cookie: who.headers.cookie, origin },
    });
    this.opened = new Promise((resolve, reject) => {
      this.socket.addEventListener('open', () => resolve(), { once: true });
      this.socket.addEventListener('error', () => reject(new Error('upgrade refused')), { once: true });
    });
    this.closed = new Promise((resolve) =>
      this.socket.addEventListener('close', (event) => resolve(event.code)),
    );
    this.socket.addEventListener('message', (event) => {
      this.inbox.push(JSON.parse(String(event.data)) as ScriptServerMessage);
    });
    sockets.push(this);
  }

  send(message: ScriptClientMessage): void {
    this.socket.send(JSON.stringify(message));
  }

  async next<T extends ScriptServerMessage['type']>(
    type: T,
  ): Promise<Extract<ScriptServerMessage, { type: T }>> {
    let index = -1;
    await until(() => (index = this.inbox.findIndex((message) => message.type === type)) >= 0);
    return this.inbox.splice(index, 1)[0] as Extract<ScriptServerMessage, { type: T }>;
  }

  async close(): Promise<void> {
    if (this.socket.readyState === WebSocket.OPEN) this.socket.close();
    await this.closed;
  }
}

async function open(scriptId: string, who: SignedIn = base.editor): Promise<PanelSocket> {
  const socket = new PanelSocket(scriptId, who);
  await socket.opened;
  socket.send({ type: 'start', csrf: who.info.csrfToken });
  return socket;
}

async function schemaOf(who: SignedIn): Promise<DatabaseSchema> {
  const response = await server.app.inject({
    method: 'GET',
    url: `/api/databases/${base.databaseId}/schema`,
    headers: who.headers,
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<DatabaseSchema>();
}

describe('the run socket', () => {
  it('runs a saved script, pausing on a prompt until the panel answers', async () => {
    const script = await saveScript(
      server,
      base,
      `const name = await input.textAsync('Your name?')
      console.info('asked')
      await records.create(${JSON.stringify(base.notes)}, { ${JSON.stringify(base.f.note)}: 'Hi ' + name })
      await output.markdown('**Hello, ' + name + '**')`,
    );
    const socket = await open(script.id);
    const started = await socket.next('started');
    expect(started).toMatchObject({
      runId: expect.stringMatching(/^job/),
      groupId: expect.stringMatching(/^act/),
    });
    expect(started.timeoutMs).toBe(60_000);
    expect(started.runMs).toBe(30 * 60_000);
    const prompt = await socket.next('prompt');
    expect(prompt.prompt).toEqual({ kind: 'text', label: 'Your name?' });
    // An answer to some other prompt is ignored.
    socket.send({ type: 'answer', promptId: prompt.promptId + 1, value: 'Wrong' });
    socket.send({ type: 'answer', promptId: prompt.promptId, value: 'Ada' });
    expect(await socket.next('log')).toEqual({ type: 'log', level: 'info', text: 'asked' });
    expect(await socket.next('wrote')).toEqual({ type: 'wrote', writes: 1 });
    expect(await socket.next('output')).toEqual({
      type: 'output',
      output: { kind: 'markdown', text: '**Hello, Ada**' },
    });
    expect(await socket.next('finished')).toMatchObject({ state: 'succeeded', writes: 1, error: null });
    expect(await socket.closed).toBe(1000);
    // The panel undoes the run's writes as one action.
    const undone = await server.app.inject({
      method: 'POST',
      url: `/api/databases/${base.databaseId}/undo`,
      headers: base.editor.headers,
      payload: { clientId: newId('client'), groupId: started.groupId, commandId: newId('command') },
    });
    expect(undone.json<UndoResult>()).toMatchObject({ status: 'applied' });
  });

  it('stops the run when the panel cancels or goes away', async () => {
    const script = await saveScript(server, base, 'await input.buttonsAsync("Wait", ["Never"])');
    const canceled = await open(script.id);
    await canceled.next('prompt');
    canceled.send({ type: 'cancel' });
    expect(await canceled.next('finished')).toMatchObject({
      state: 'canceled',
      error: { messageKey: 'scripts.run.canceled' },
    });
    const spinning = await saveScript(server, base, 'while (true) {}');
    const loop = await open(spinning.id);
    await loop.next('started');
    loop.send({ type: 'cancel' });
    expect(await loop.next('finished')).toMatchObject({ state: 'canceled' });
    // Closing the socket is a cancel too, and frees the person's place for another run.
    for (let i = 0; i < PANEL_RUNS.perPerson; i += 1) {
      const gone = await open(script.id);
      await gone.next('prompt');
      await gone.close();
    }
    // The server frees the places as the runs wind down, a moment after the sockets close.
    let next: PanelSocket | undefined;
    let opening = false;
    await until(() => {
      if (next?.inbox.some((message) => message.type === 'prompt')) return true;
      if (opening || (next && !next.inbox.some((message) => message.type === 'refused'))) return false;
      opening = true;
      void open(script.id).then((socket) => {
        next = socket;
        opening = false;
      });
      return false;
    });
  });

  it('lets a person run only as many scripts at once as the limit allows', async () => {
    const script = await saveScript(server, base, 'await input.textAsync("Hold")');
    const running = [];
    for (let i = 0; i < PANEL_RUNS.perPerson; i += 1) {
      const socket = await open(script.id);
      await socket.next('prompt');
      running.push(socket);
    }
    const extra = await open(script.id);
    expect(await extra.next('refused')).toEqual({ type: 'refused', messageKey: 'scripts.run.busy' });
    await Promise.all(running.map((socket) => socket.close()));
  });

  it('runs for people who can edit records and refuses everyone else', async () => {
    const script = await saveScript(server, base, "await output.text('ran')");
    const reader = await open(script.id, base.reader);
    expect(await reader.next('refused')).toEqual({ type: 'refused', messageKey: 'data.access.denied' });
    const outsider = await server.addMember({ name: 'Outsider' });
    const stranger = await open(script.id, outsider);
    expect(await stranger.next('refused')).toEqual({ type: 'refused', messageKey: 'errors.notFound' });
    const missing = await open(newId('script'));
    expect(await missing.next('refused')).toEqual({ type: 'refused', messageKey: 'errors.notFound' });
    const editor = await open(script.id, base.editor);
    expect(await editor.next('finished')).toMatchObject({ state: 'succeeded' });
  });

  it('needs the session’s CSRF token first, and its own origin', async () => {
    const script = await saveScript(server, base, "await output.text('ran')");
    const forged = new PanelSocket(script.id, base.editor);
    await forged.opened;
    forged.send({ type: 'start', csrf: 'not the token' });
    expect(await forged.closed).toBe(4401);
    const early = new PanelSocket(script.id, base.editor);
    await early.opened;
    early.send({ type: 'cancel' });
    expect(await early.closed).toBe(4401);
    const elsewhere = new PanelSocket(script.id, base.editor, 'https://elsewhere.example');
    await expect(elsewhere.opened).rejects.toThrow('upgrade refused');
  });
});

describe('saved scripts', () => {
  it('are saved by people who can change the schema, and undo like other schema changes', async () => {
    const id = newId('script');
    const create = {
      kind: 'script.create',
      script: { id, name: 'Tidy', description: 'Tidies', source: '1' },
    };
    const [refused] = await send(server, base.editor, base.databaseId, [create]);
    expect(refused).toMatchObject({ status: 'rejected', error: { messageKey: 'data.access.denied' } });
    await apply(server, base.creator, base.databaseId, [create]);
    const groupId = newId('action');
    await apply(
      server,
      base.creator,
      base.databaseId,
      [{ kind: 'script.update', scriptId: id, name: 'Tidy up', source: 'await output.text("tidy")' }],
      groupId,
    );
    const [editorUpdate] = await send(server, base.editor, base.databaseId, [
      { kind: 'script.update', scriptId: id, source: 'await output.text("mine now")' },
    ]);
    expect(editorUpdate).toMatchObject({ status: 'rejected' });
    expect((await schemaOf(base.creator)).scripts?.find((item) => item.id === id)).toMatchObject({
      name: 'Tidy up',
      description: 'Tidies',
      source: 'await output.text("tidy")',
    });
    const undo = await server.app.inject({
      method: 'POST',
      url: `/api/databases/${base.databaseId}/undo`,
      headers: base.creator.headers,
      payload: { clientId: newId('client'), groupId, commandId: newId('command') },
    });
    expect(undo.json<UndoResult>()).toMatchObject({ status: 'applied' });
    expect((await schemaOf(base.creator)).scripts?.find((item) => item.id === id)).toMatchObject({
      name: 'Tidy',
      source: '1',
    });
    // Deleting sends it to the trash, where it can come back from.
    await apply(server, base.creator, base.databaseId, [{ kind: 'script.trash', scriptId: id }]);
    expect((await schemaOf(base.creator)).scripts?.some((item) => item.id === id)).toBe(false);
    const trash = await server.app.inject({
      method: 'GET',
      url: `/api/databases/${base.databaseId}/trash`,
      headers: base.creator.headers,
    });
    expect(trash.json<DatabaseTrash>().items).toContainEqual(
      expect.objectContaining({ kind: 'script', id, name: 'Tidy' }),
    );
    await apply(server, base.creator, base.databaseId, [{ kind: 'script.restore', scriptId: id }]);
    expect((await schemaOf(base.creator)).scripts?.some((item) => item.id === id)).toBe(true);
  });

  it('show their code only to people who can change them', async () => {
    const script = await saveScript(server, base, 'const key = "k-" + "secret"', 'Keyed');
    for (const who of [base.editor, base.reader]) {
      const listed = (await schemaOf(who)).scripts?.find((item) => item.id === script.id);
      expect(listed).toMatchObject({ name: 'Keyed', source: '' });
    }
    expect((await schemaOf(base.creator)).scripts?.find((item) => item.id === script.id)?.source).toBe(
      script.source,
    );
  });
});
