import { idKind, newId, type IdKind } from '@riosoma/contracts';

/**
 * Old IDs to new ones, for a copy.  Every part of an archive gets a new ID, and every reference to
 * a part follows it: in field options, formulas and button links, view settings, dashboards,
 * automations, and interfaces.  Only IDs the archive itself holds are replaced, so text that merely
 * looks like an ID stays as it was, and a reference to something the archive left out, such as a
 * field in the trash, stays pointing at nothing in the copy.
 */
const ID_SHAPE = /\b[a-z]{2,3}[0-9A-Za-z]{14}\b/g;

export class IdMap {
  private readonly ids = new Map<string, string>();

  /** Gives `old` a new ID of the same kind, once, and answers it. */
  add(old: string, kind?: IdKind): string {
    const known = this.ids.get(old);
    if (known) return known;
    const found = kind ?? idKind(old);
    if (!found) throw new Error('Not an ID');
    const fresh = newId(found);
    this.ids.set(old, fresh);
    return fresh;
  }

  /** Records a new ID the server chose, such as the other side of a new link. */
  set(old: string, fresh: string): void {
    this.ids.set(old, fresh);
  }

  has(old: string): boolean {
    return this.ids.has(old);
  }

  /** The new ID for an old one the archive holds. */
  get(old: string): string {
    const fresh = this.ids.get(old);
    if (!fresh) throw new Error('Unknown archive ID');
    return fresh;
  }

  /** The new ID, or null for one the archive doesn't hold. */
  find(old: string): string | null {
    return this.ids.get(old) ?? null;
  }

  /** Text with every archive ID in it replaced, such as a formula or a button's link. */
  text(value: string): string {
    return value.replace(ID_SHAPE, (match) => this.ids.get(match) ?? match);
  }

  /** A JSON value with every archive ID in its strings and keys replaced. */
  json<T>(value: T): T {
    return this.walk(value) as T;
  }

  private walk(value: unknown): unknown {
    if (typeof value === 'string') return this.text(value);
    if (Array.isArray(value)) return value.map((item) => this.walk(item));
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, item]) => [
          this.text(key),
          this.walk(item),
        ]),
      );
    return value;
  }
}
