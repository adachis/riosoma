import {
  AIRTABLE_IMPORT_LIMITS,
  AppError,
  LIMITS,
  type AirtableBase,
  type AirtableImport,
  type AirtableImportProgress,
  type AirtableImportRequest,
} from '@riosoma/contracts';
import type { FastifyInstance } from 'fastify';
import { systemResolve, type Resolve } from '../../../automations/outbound.js';
import type { Actor } from '../../../http/policy.js';
import { allowsPrivate } from '../../../webhooks/url.js';
import { ImportRunner, type ActiveImport, type ImportWork } from '../core/runner.js';
import type { ImportRow } from '../core/store.js';
import { AIRTABLE_API_URL, AirtableClient, RateLimiter, systemClock, type Clock } from './api.js';
import { ImportJob, type ImportLimits } from './job.js';
import { AIRTABLE_TABLE, importOf } from './store.js';

/**
 * Runs Airtable imports in the background, a couple at a time, oldest first.  A person has one
 * import going at a time.  The token waits sealed in the import's row until the import starts, is
 * unsealed only into the running import's memory, and is wiped from the row when the import ends.
 * Someone who asks an import to stop gets it stopped at its next step, and what it made so far goes
 * to the trash.  An import a stopped server left behind is ended the next time anyone looks.  The
 * queue, the sealing, and the ending are the shared import runner's.
 */

interface Input {
  baseId: string;
  name: string;
  viewName: string;
}

export class AirtableImporter extends ImportRunner<Input, AirtableImport> {
  /** Where Airtable's API answers.  Tests point it at a stand-in. */
  apiUrl = AIRTABLE_API_URL;
  /** Time as imports see it.  Tests use one that moves only when something waits. */
  clock: Clock = systemClock;
  /** How attachment hosts are resolved.  Tests swap in their own. */
  resolve: Resolve = systemResolve;
  /** Whether an attachment's address may be on a private network */
  allowPrivate: (url: URL) => boolean;
  limits: ImportLimits = {
    fileBytes: AIRTABLE_IMPORT_LIMITS.fileBytes,
    totalFileBytes: AIRTABLE_IMPORT_LIMITS.totalFileBytes,
    inferenceRecords: AIRTABLE_IMPORT_LIMITS.inferenceRecords,
  };

  private readonly limiters = new Map<string, RateLimiter>();

  constructor(app: FastifyInstance) {
    super(app, {
      table: AIRTABLE_TABLE,
      audit: 'imports.airtable',
      sealContext: 'riosoma.imports.airtable.token',
      lock: 'airtable-import',
      busy: 'import.airtable.busy',
      failed: 'import.airtable.failed',
      label: 'airtable import',
    });
    this.allowPrivate = (url) => allowsPrivate(url.href, app.ctx.config);
  }

  protected present(row: ImportRow): AirtableImport {
    return importOf(row);
  }

  /** One limiter per base, shared by every import of it, so together they stay under Airtable's limit. */
  limiter(key: string): RateLimiter {
    let limiter = this.limiters.get(key);
    if (!limiter) {
      limiter = new RateLimiter(this.clock);
      this.limiters.set(key, limiter);
    }
    return limiter;
  }

  private client(token: string, signal?: AbortSignal): AirtableClient {
    const discoveryLimiter = new RateLimiter(this.clock);
    return new AirtableClient({
      apiUrl: this.apiUrl,
      token,
      clock: this.clock,
      limiter: (key) => (key === 'workspace-discovery' ? discoveryLimiter : this.limiter(key)),
      ...(signal ? { signal } : {}),
    });
  }

  /** The bases a token can see.  The token is used for this and forgotten. */
  bases(token: string, signal?: AbortSignal): Promise<AirtableBase[]> {
    return this.client(token, signal).groupedBases();
  }

  /** Starts an import, or refuses when the person already has one going. */
  async begin(actor: Actor, request: AirtableImportRequest): Promise<AirtableImport> {
    if (actor.kind === 'guest') throw new AppError('forbidden', 'data.access.denied');
    await this.sweep();
    // Asking Airtable for the base's name also proves the token works before anything waits on it.
    const name =
      request.name ??
      ((await this.client(request.token).bases())
        .find((base) => base.id === request.baseId)
        ?.name.trim()
        .slice(0, LIMITS.nameLength) ||
        request.baseId);
    return this.enqueue(
      actor,
      { baseId: request.baseId, name, token: request.token },
      { baseId: request.baseId, name, viewName: request.viewName ?? 'Grid' },
    );
  }

  protected work(
    active: ActiveImport<Input>,
    token: string,
    signal: AbortSignal,
    progress: (patch: Partial<AirtableImportProgress>) => Promise<void>,
  ): ImportWork {
    return new ImportJob(
      { id: active.id, ...active.input },
      {
        app: this.app,
        actor: active.actor,
        client: this.client(token, signal),
        resolve: this.resolve,
        allowPrivate: (url) => this.allowPrivate(url),
        limits: this.limits,
        signal,
        progress,
      },
    );
  }
}
