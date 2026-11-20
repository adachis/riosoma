import type { DocModule } from '../../docs/loader';

/** Deterministic keyword matching quotes documentation without inventing an answer. */
export function searchHelp(topics: readonly DocModule[], question: string) {
  const terms = [...new Set(question.toLocaleLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [])];
  if (!terms.length) return [];
  return topics
    .flatMap(({ meta, body }) => {
      const passages = body.split(/\n\s*\n/).filter((text) => !/^(?:#|```|\||\s*-)/.test(text));
      const title = meta.title.toLocaleLowerCase();
      const scored = passages
        .map((text) => ({
          id: meta.id,
          title: meta.title,
          text: text
            .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
            .replace(/[*`]/g, '')
            .slice(0, 1200),
          score: terms.reduce(
            (score, term) =>
              score + (text.toLocaleLowerCase().includes(term) ? 1 : 0) + (title.includes(term) ? 2 : 0),
            0,
          ),
        }))
        .sort((a, b) => b.score - a.score);
      return scored[0]?.score ? [scored[0]] : [];
    })
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, 3);
}
