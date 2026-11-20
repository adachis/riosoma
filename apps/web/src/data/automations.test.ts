import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AutomationConfig, newId, type AutomationMeta } from '@riosoma/contracts';
import { openDatabase } from './session';
import { FakeServer } from './testing';
import type { FakeFixture } from './testing';
import type { DatabaseSession } from './types';

async function settle(): Promise<void> {
  for (let index = 0; index < 80; index++) await Promise.resolve();
}

let server: FakeServer, fixture: FakeFixture, session: DatabaseSession;
const config = (): AutomationConfig =>
  AutomationConfig.parse({ trigger: { kind: 'recordCreated', tableId: fixture.tableId } });

function seeded(name: string, position: number, extra: Partial<AutomationMeta> = {}): AutomationMeta {
  return {
    id: newId('automation'),
    databaseId: fixture.databaseId,
    name,
    position,
    enabled: false,
    config: config(),
    runAsId: null,
    stoppedBecause: null,
    webhookPath: null,
    lastRunAt: null,
    createdAt: '',
    updatedAt: '',
    ...extra,
  };
}

beforeEach(async () => {
  vi.useFakeTimers();
  server = new FakeServer();
  fixture = server.createDatabase(3);
  server.database(fixture.databaseId).schema.automations = [
    seeded('Second', 2),
    seeded('First', 1, { enabled: true, runAsId: server.remoteUserId }),
  ];
  session = await openDatabase(fixture.databaseId, server.deps());
  await settle();
});
afterEach(() => {
  session.close();
  vi.useRealTimers();
});

const names = () => session.getSchema().automations.map((automation) => automation.name);

describe('automations in the session', () => {
  it('reads them from the schema in sidebar order', () => {
    expect(names()).toEqual(['First', 'Second']);
    const first = session.getSchema().automations[0]!;
    expect(session.getSchema().automationById.get(first.id)).toBe(first);
  });

  it('reads none from a schema that has no automations yet', async () => {
    const other = server.createDatabase(0);
    const empty = await openDatabase(other.databaseId, server.deps());
    expect(empty.getSchema().automations).toEqual([]);
    empty.close();
  });

  it('shows a new automation at once, off and at the end, and keeps it once saved', async () => {
    const id = newId('automation');
    const action = session.run([
      { kind: 'automation.create', automation: { id, name: 'Notify', config: config() } },
    ]);
    const created = session.getSchema().automationById.get(id)!;
    expect(created).toMatchObject({ name: 'Notify', enabled: false, runAsId: null, stoppedBecause: null });
    expect(names()).toEqual(['First', 'Second', 'Notify']);
    await action.done;
    await settle();
    expect(session.getSchema().automationById.get(id)).toMatchObject({ name: 'Notify', enabled: false });
    expect(server.database(fixture.databaseId).schema.automations?.map((item) => item.id)).toContain(id);
  });

  it('predicts renames, drafts, and turning on as the person who did it', async () => {
    const [first] = session.getSchema().automations;
    const published = first!.config;
    const next = AutomationConfig.parse({
      trigger: { kind: 'webhook' },
      steps: [{ id: 'step_one', kind: 'sendEmail', to: ['a@example.test'], subject: 'Hi', body: '' }],
    });
    session.run([{ kind: 'automation.update', automationId: first!.id, name: 'Renamed', config: next }]);
    // A changed configuration is a draft, and what's published stays until someone publishes it.
    expect(session.getSchema().automationById.get(first!.id)).toMatchObject({
      name: 'Renamed',
      config: published,
      draft: { config: next, updatedBy: server.userId },
    });
    const second = session.getSchema().automations[1]!;
    const action = session.run([{ kind: 'automation.update', automationId: second.id, enabled: true }]);
    expect(session.getSchema().automationById.get(second.id)).toMatchObject({
      enabled: true,
      runAsId: server.userId,
    });
    await action.done;
    await settle();
    // The server gives a webhook automation its address, a draft's included.
    expect(session.getSchema().automationById.get(first!.id)?.webhookPath).toMatch(/^\/api\/hooks\//);
    session.run([{ kind: 'automation.publish', automationId: first!.id }]);
    expect(session.getSchema().automationById.get(first!.id)).toMatchObject({
      config: next,
      draft: null,
      version: 2,
    });
  });

  it('reorders by position', async () => {
    const [first, second] = session.getSchema().automations;
    session.run([{ kind: 'automation.move', automationId: first!.id, position: second!.position + 1 }]);
    expect(names()).toEqual(['Second', 'First']);
  });

  it('follows changes from other people', async () => {
    const id = newId('automation');
    server.remote(fixture.databaseId, [
      { kind: 'automation.create', automation: { id, name: 'Theirs', config: config() } },
    ]);
    await settle();
    expect(names()).toEqual(['First', 'Second', 'Theirs']);
    server.remote(fixture.databaseId, [{ kind: 'automation.trash', automationId: id }]);
    await settle();
    expect(names()).toEqual(['First', 'Second']);
  });

  it('undoes and redoes a deletion, like views', async () => {
    const [first] = session.getSchema().automations;
    await session.run([{ kind: 'automation.trash', automationId: first!.id }]).done;
    await settle();
    expect(names()).toEqual(['Second']);
    expect(session.getSchema().automationById.has(first!.id)).toBe(false);
    const undo = session.undo();
    await settle();
    await undo;
    await settle();
    expect(names()).toEqual(['First', 'Second']);
    const redo = session.redo();
    await settle();
    await redo;
    await settle();
    expect(names()).toEqual(['Second']);
  });

  it('undoes a publish back to the version before it, with its draft', async () => {
    const [first] = session.getSchema().automations;
    const before = first!.config;
    await session.run([
      {
        kind: 'automation.update',
        automationId: first!.id,
        config: { ...before, trigger: { kind: 'webhook' } },
      },
    ]).done;
    await session.run([{ kind: 'automation.publish', automationId: first!.id }]).done;
    await settle();
    expect(session.getSchema().automationById.get(first!.id)?.config.trigger.kind).toBe('webhook');
    const undo = session.undo();
    await settle();
    await undo;
    await settle();
    const undone = session.getSchema().automationById.get(first!.id);
    expect(undone?.config).toEqual(before);
    expect(undone?.draft?.config.trigger.kind).toBe('webhook');
  });

  it('rolls back a rejected change', async () => {
    const [first] = session.getSchema().automations;
    server.rejectNext('errors.forbidden');
    const action = session.run([{ kind: 'automation.update', automationId: first!.id, name: 'Nope' }]);
    expect(names()[0]).toBe('Nope');
    await action.done;
    await settle();
    expect(names()[0]).toBe('First');
  });
});
