import type { SourceObject, SourceObjectRef } from '@riosoma/contracts';
import type { DocumentOrder, Predicate } from './query.js';

// Native identity is independent of sampled display types and is never exposed as a cell.
const identities = new WeakMap<Record<string, unknown>, ReadonlyMap<string, string>>();
export function identify(document: Record<string, unknown>, keys: ReadonlyMap<string, string>): void {
  identities.set(document, keys);
}
export function documentKey(document: Record<string, unknown>, field: string): string | undefined {
  return identities.get(document)?.get(field);
}

export interface DocumentPage {
  documents: Record<string, unknown>[];
  deleted?: string[];
  cursor?: string;
}
export interface DocumentBackend {
  list(): Promise<SourceObject[]>;
  keys(object: SourceObjectRef): Promise<string[]>;
  pages(
    object: SourceObjectRef,
    predicate: Predicate,
    order: DocumentOrder[],
    limit?: number,
  ): AsyncIterable<DocumentPage>;
  checkpoint?(object: SourceObjectRef): Promise<string>;
  changes?(object: SourceObjectRef, since: string): AsyncIterable<DocumentPage>;
}
export function object(name: string, schema: string | null = null): SourceObject {
  return { name, schema, type: 'collection', rowEstimate: null };
}
