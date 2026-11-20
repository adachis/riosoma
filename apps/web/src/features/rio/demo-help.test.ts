import { describe, expect, it, vi } from 'vitest';
import { searchHelp } from './demo-help';
import { listModules, loadModule, type DocModule } from '../../docs/loader';

it('finds built-in passages and links without a provider, outbound request, or record read', async () => {
  const topics = (
    await Promise.all((await listModules('en-US')).map((topic) => loadModule(topic.id, 'en-US')))
  ).filter((topic): topic is DocModule => topic !== null);
  const fetch = vi.spyOn(globalThis, 'fetch');
  try {
    const answer = searchHelp(topics, 'read-only public demo');
    expect(answer.length).toBeGreaterThan(0);
    expect(answer.some((passage) => passage.id === 'public-demo-mode')).toBe(true);
    expect(
      answer.every((passage) =>
        topics.some((topic) => topic.meta.id === passage.id && topic.meta.title === passage.title),
      ),
    ).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    fetch.mockRestore();
  }
});

describe('honest help matching', () => {
  it('reports no match instead of inventing an answer', () => {
    expect(searchHelp([], 'anything')).toEqual([]);
  });
});
