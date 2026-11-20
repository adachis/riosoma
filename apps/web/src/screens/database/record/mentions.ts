import { MENTION_PATTERN } from '@riosoma/contracts';

/**
 * Reading and writing the mentions inside a comment's text.
 *
 * A mention is written `@[Name](usr…)` so a body stays one plain string: the name is only what the
 * writer saw, and the ID is what the thread renders from, so a renamed person is still themselves.
 */

/** How many people the offer shows; typing narrows it to the one wanted. */
const OFFER_LIMIT = 8;

/** Characters a query must not carry, because they end the markup around a mention. */
const MARKUP = /[[\]()\n]/;
/** The same characters, matched everywhere, for cleaning them out of a name. */
const MARKUP_EVERY = /[[\]()\n]/g;

export interface MentionPerson {
  id: string;
  name: string;
  email?: string;
  pictureUrl?: string | null;
  deactivated?: boolean;
}

/** One piece of a comment's text: plain text, or a mention of a person. */
export type CommentPart = { text: string } | { mentionId: string; writtenName: string };

/** Splits a body into its text and mentions, in the order they appear. */
export function commentParts(body: string): CommentPart[] {
  const parts: CommentPart[] = [];
  let index = 0;
  for (const match of body.matchAll(MENTION_PATTERN)) {
    const start = match.index ?? 0;
    if (start > index) parts.push({ text: body.slice(index, start) });
    parts.push({ mentionId: match[2]!, writtenName: match[1]! });
    index = start + match[0].length;
  }
  if (index < body.length) parts.push({ text: body.slice(index) });
  return parts;
}

/** The IDs a body mentions, keeping only the people who can read the database. */
export function mentionedIds(body: string, known: Iterable<string>): string[] {
  const readable = new Set(known);
  const ids: string[] = [];
  for (const match of body.matchAll(MENTION_PATTERN)) {
    const id = match[2];
    if (id && readable.has(id) && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** The `@query` a caret sits in, or null when the caret isn't writing a mention. */
export interface MentionDraft {
  /** Position of the `@` */
  start: number;
  /** Position just past what has been typed of the name */
  end: number;
  query: string;
}

export function mentionAt(text: string, caret: number): MentionDraft | null {
  const at = Math.max(0, Math.min(caret, text.length));
  let start = at;
  while (start > 0 && text[start - 1] !== '@' && !/\s/.test(text[start - 1]!)) start--;
  if (start === 0 || text[start - 1] !== '@') return null;
  // An `@` inside a word ("a@b") is an address, not a mention.
  if (start > 1 && !/\s/.test(text[start - 2]!)) return null;
  const query = text.slice(start, at);
  // Caret inside a finished mention, or past what a name can hold: nothing to offer.
  if (MARKUP.test(query) || query.length > 100) return null;
  return { start: start - 1, end: at, query };
}

/**
 * Replaces a draft with the markup for a person, followed by a space so the next word starts
 * clean, and says where the caret goes.
 */
export function insertMention(
  text: string,
  draft: MentionDraft,
  person: MentionPerson,
): { text: string; caret: number } {
  const name = person.name.replace(MARKUP_EVERY, '').trim() || person.id;
  const markup = `@[${name}](${person.id}) `;
  return {
    text: `${text.slice(0, draft.start)}${markup}${text.slice(draft.end)}`,
    caret: draft.start + markup.length,
  };
}

/** The collaborators whose name or address holds the query, in the database's own order. */
export function findPeople(
  people: Iterable<MentionPerson>,
  query: string,
  locale: string,
  limit = OFFER_LIMIT,
): MentionPerson[] {
  const wanted = query.trim().toLocaleLowerCase(locale);
  const matches: MentionPerson[] = [];
  for (const person of people) {
    if (matches.length >= limit) break;
    if (
      !wanted ||
      person.name.toLocaleLowerCase(locale).includes(wanted) ||
      person.email?.toLocaleLowerCase(locale).includes(wanted)
    )
      matches.push(person);
  }
  return matches;
}
