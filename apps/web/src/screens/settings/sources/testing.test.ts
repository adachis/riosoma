import { describe, expect, it } from 'vitest';
import type { SourceCreate } from '@riosoma/contracts';
import { mockSources, POSTGRES_CONNECTION } from './testing';

/** A stand-in password, built when the tests run so no secret is ever written down. */
const STAND_IN = ['stand', 'in', Math.random().toString(36).slice(2, 8)].join('-');

function create(name: string): SourceCreate {
  return {
    name,
    description: '',
    connection: POSTGRES_CONNECTION,
    secrets: { password: STAND_IN },
    access: 'admins',
  };
}

async function save(mock: ReturnType<typeof mockSources>, name: string): Promise<void> {
  await mock.handle('/api/sources', { method: 'POST', body: JSON.stringify(create(name)) });
}

describe('the sources a test server holds', () => {
  it('gives every source it saves its own id', async () => {
    const mock = mockSources();
    await save(mock, 'Autonomous');
    await save(mock, 'Stock');
    const saved = mock.sources().slice(-2);
    expect(saved.map((source) => source.name)).toEqual(['Autonomous', 'Stock']);
    // Two rows sharing an id are two children with one key, and React drops one of them, so a
    // source someone just saved would be missing from the list beside it.
    expect(new Set(saved.map((source) => source.id)).size).toBe(2);
  });

  it('answers with the source it saved, so the page can follow it', async () => {
    const mock = mockSources();
    const reply = await mock.handle('/api/sources', {
      method: 'POST',
      body: JSON.stringify(create('Ledger')),
    });
    const saved = (await reply.json()) as { id: string; name: string };
    expect(saved.name).toBe('Ledger');
    expect(mock.sources().some((source) => source.id === saved.id)).toBe(true);
  });
});
