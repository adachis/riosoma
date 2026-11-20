import type {
  AiFieldCellState,
  AiFieldEstimate,
  AiFieldGenerate,
  AiFieldJobView,
  AiFieldsStatus,
} from '@riosoma/contracts';
import { api } from '../../api';

const EMPTY: AiFieldsStatus = { unavailable: null, problems: [], cells: [], jobs: [] };
/** How often a table with work under way asks again */
const BUSY_POLL_MS = 2_000;
/** How long a burst of record changes settles before the table asks */
const SETTLE_MS = 400;

export const estimateRun = (fieldId: string, scope: 'all' | 'empty') =>
  api<AiFieldEstimate>(`/api/fields/${fieldId}/ai/estimate`, { method: 'POST', body: { scope } });

export const startRun = (fieldId: string, request: AiFieldGenerate) =>
  api<{ queued: number; job: AiFieldJobView | null }>(`/api/fields/${fieldId}/ai/generate`, {
    method: 'POST',
    body: request,
  });

export const cancelRun = (jobId: string) =>
  api<void>(`/api/ai-field-jobs/${jobId}/cancel`, { method: 'POST' });

/**
 * Where a table's AI fields stand: cells waiting for their run or showing an error, bulk runs and
 * how far they've come, and why runs can't go.  It asks the server while anything is under way and
 * can go, and again when records change, since an edit anywhere can queue a run.
 */
export class AiFieldStatusStore {
  private status: AiFieldsStatus = EMPTY;
  private cells = new Map<string, AiFieldCellState>();
  private readonly listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private loading: Promise<void> | undefined;
  private stopped = false;

  constructor(
    readonly tableId: string,
    private readonly fetchStatus: (tableId: string) => Promise<AiFieldsStatus> = (id) =>
      api<AiFieldsStatus>(`/api/tables/${id}/ai-fields`),
  ) {}

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getSnapshot = () => this.status;

  /** A cell's pending or error state, if it has one. */
  cell(recordId: string, fieldId: string): AiFieldCellState | undefined {
    return this.cells.get(`${recordId}:${fieldId}`);
  }

  /** The field's newest bulk run, while it's going or just after it ends. */
  job(fieldId: string): AiFieldJobView | undefined {
    return this.status.jobs.find((job) => job.fieldId === fieldId);
  }

  /** Why the field's runs stop, or why none can run in the organization, as a message key. */
  problem(fieldId: string): string | undefined {
    return (
      this.status.unavailable ??
      this.status.problems.find((problem) => problem.fieldId === fieldId)?.messageKey
    );
  }

  start(): () => void {
    this.stopped = false;
    void this.refresh();
    return () => this.stop();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
  }

  /** Asks again soon, once a burst of changes has settled. */
  nudge(): void {
    if (this.stopped) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.refresh(), SETTLE_MS);
  }

  refresh(): Promise<void> {
    this.loading ??= this.load().finally(() => {
      this.loading = undefined;
    });
    return this.loading;
  }

  private async load(): Promise<void> {
    if (this.stopped) return;
    try {
      const next = await this.fetchStatus(this.tableId);
      if (this.stopped) return;
      const changed = JSON.stringify(next) !== JSON.stringify(this.status);
      this.status = next;
      this.cells = new Map(next.cells.map((cell) => [`${cell.recordId}:${cell.fieldId}`, cell]));
      if (changed) for (const listener of this.listeners) listener();
    } catch {
      // A failed look leaves the last state showing, and the next change or poll asks again.
    }
    if (this.stopped) return;
    // Runs that can't go, such as ones waiting for next month's budget, aren't worth asking after.
    const busy =
      !this.status.unavailable &&
      (this.status.cells.some((cell) => cell.state === 'pending') ||
        this.status.jobs.some((job) => job.state === 'running'));
    clearTimeout(this.timer);
    if (busy) this.timer = setTimeout(() => void this.refresh(), BUSY_POLL_MS);
  }
}
