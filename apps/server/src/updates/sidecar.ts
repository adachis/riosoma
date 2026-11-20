import { UPDATE_RUN_STATES, UPDATER_PROBLEMS, type UpdaterProblem } from '@riosoma/contracts';
import { z } from 'zod';

/**
 * The server's side of the updater sidecar.  The sidecar holds the Docker socket, so it trusts the
 * server with nothing but the version to update to, the run it belongs to, and the signed feed: it
 * checks the feed's signature itself, works out which release this install may update to the way
 * the server does, takes the image from the registry its own container runs from, and pulls it by
 * the digest the feed names.  Every request carries the token the two share.
 */

const Problem = z
  .string()
  .transform((value): UpdaterProblem | null =>
    (UPDATER_PROBLEMS as readonly string[]).includes(value) ? (value as UpdaterProblem) : null,
  );

export const SidecarJob = z.object({
  id: z.string().min(1).max(100),
  fromVersion: z.string().max(64).nullable(),
  toVersion: z.string().max(64),
  state: z.enum(UPDATE_RUN_STATES),
  backup: z.string().max(255).nullable().default(null),
  problem: Problem.nullable().default(null),
});
export type SidecarJob = z.infer<typeof SidecarJob>;

const Status = z.object({
  ready: z.boolean(),
  problem: Problem.nullable().default(null),
  /** The release the sidecar itself runs, which the image it came from sets */
  updater: z.string().max(64).nullable().default(null),
  job: SidecarJob.nullable().default(null),
});
export type SidecarStatus = z.infer<typeof Status>;

const Refusal = z.object({ problem: Problem });

/**
 * Why a request to the sidecar failed: what it answered, or `unreachable`.  `status` is the HTTP
 * status it answered with, or 0 when it didn't answer at all, so a sidecar that doesn't know a run
 * can be told from one that can't be reached.
 */
export class SidecarError extends Error {
  constructor(
    readonly problem: UpdaterProblem,
    readonly status = 0,
  ) {
    super(`updater: ${problem}`);
  }
}

export class Sidecar {
  constructor(
    private readonly url: string,
    private readonly token: string,
  ) {}

  private async call<T extends z.ZodType>(
    schema: T,
    path: string,
    init: { method?: string; body?: unknown; timeoutMs?: number } = {},
  ): Promise<z.infer<T>> {
    let response: Response;
    try {
      response = await fetch(`${this.url}${path}`, {
        method: init.method ?? 'GET',
        headers: {
          authorization: `Bearer ${this.token}`,
          accept: 'application/json',
          ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        redirect: 'error',
        signal: AbortSignal.timeout(init.timeoutMs ?? 5_000),
      });
    } catch {
      throw new SidecarError('unreachable');
    }
    const body: unknown = await response.json().catch(() => null);
    if (response.status === 401) throw new SidecarError('token', 401);
    if (!response.ok) {
      const refusal = Refusal.safeParse(body);
      throw new SidecarError((refusal.success && refusal.data.problem) || 'unreachable', response.status);
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) throw new SidecarError('unreachable', response.status);
    return parsed.data;
  }

  status(): Promise<SidecarStatus> {
    return this.call(Status, '/v1/status', { timeoutMs: 3_000 });
  }

  /**
   * Asks for an update to `version` as run `runId`, handing over the signed feed exactly as the hub
   * signed it and the schema the run is recorded in, so the sidecar can check that the backup
   * service's database is this one.
   */
  async start(version: string, feed: string, runId: string, schema: string): Promise<SidecarJob> {
    const answer = await this.call(z.object({ job: SidecarJob }), '/v1/updates', {
      method: 'POST',
      body: { version, feed, runId, schema },
      timeoutMs: 60_000,
    });
    return answer.job;
  }

  async job(id: string): Promise<SidecarJob> {
    const answer = await this.call(z.object({ job: SidecarJob }), `/v1/updates/${encodeURIComponent(id)}`);
    return answer.job;
  }
}
