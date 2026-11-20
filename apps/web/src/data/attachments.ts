import { AttachmentMeta, FILE_LIMITS } from '@riosoma/contracts';
import type { Clock, Http } from './deps';

/** Details live for the database session, independently of recycled row pages. */
export class AttachmentCache {
  readonly details = new Map<string, AttachmentMeta>();
  private pending = new Set<string>();
  private requested = new Set<string>();
  private timer: unknown;
  private scanTimer: unknown;
  private controller = new AbortController();
  private listeners = new Set<() => void>();

  constructor(
    private http: Http,
    private clock: Clock,
    private changed: () => void,
  ) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  remember(files: Readonly<Record<string, AttachmentMeta>>): void {
    if (this.controller.signal.aborted) return;
    const entries = Object.values(files);
    for (const file of entries) {
      this.details.set(file.id, file);
      this.pending.delete(file.id);
    }
    if (
      this.scanTimer === undefined &&
      entries.some((file) => file.scanState === 'quarantined' || file.scanState === 'unavailable')
    ) {
      this.scanTimer = this.clock.setTimeout(() => {
        this.scanTimer = undefined;
        const ids = [...this.details.values()]
          .filter((file) => file.scanState === 'quarantined' || file.scanState === 'unavailable')
          .map((file) => file.id);
        for (const id of ids) {
          this.requested.delete(id);
          this.pending.add(id);
        }
        this.ensure(ids);
      }, 5000);
    }
    if (entries.length) {
      for (const listener of this.listeners) listener();
      this.changed();
    }
  }

  ensure(ids: readonly string[]): void {
    if (this.controller.signal.aborted) return;
    for (const id of ids) if (!this.details.has(id) && !this.requested.has(id)) this.pending.add(id);
    if (!this.pending.size || this.timer !== undefined) return;
    this.timer = this.clock.setTimeout(() => {
      this.timer = undefined;
      const ids = [...this.pending];
      this.pending.clear();
      for (let start = 0; start < ids.length; start += FILE_LIMITS.detailsPerRequest) {
        const batch = ids.slice(start, start + FILE_LIMITS.detailsPerRequest);
        batch.forEach((id) => this.requested.add(id));
        const signal = this.controller.signal;
        void this.http<unknown>(`/api/files?ids=${batch.join(',')}`, { signal })
          .then((result) => {
            if (signal.aborted) return;
            const entries = typeof result === 'object' && result !== null ? Object.values(result) : [];
            const files = entries.flatMap((entry) => {
              const parsed = AttachmentMeta.safeParse(entry);
              return parsed.success ? [parsed.data] : [];
            });
            this.remember(Object.fromEntries(files.map((file) => [file.id, file])));
          })
          .catch(() => {
            // A later read may retry a failed request; inaccessible IDs stay placeholders.
            if (!signal.aborted) {
              batch.forEach((id) => this.requested.delete(id));
              this.remember(
                Object.fromEntries(
                  batch.flatMap((id) => {
                    const file = this.details.get(id);
                    return file ? [[id, file]] : [];
                  }),
                ),
              );
            }
          });
      }
    }, 50);
  }

  reset(): void {
    this.controller.abort();
    this.clock.clearTimeout(this.timer);
    this.clock.clearTimeout(this.scanTimer);
    this.scanTimer = undefined;
    this.timer = undefined;
    this.controller = new AbortController();
    this.details.clear();
    this.pending.clear();
    this.requested.clear();
  }

  close(): void {
    this.reset();
    this.controller.abort();
    this.listeners.clear();
  }
}
