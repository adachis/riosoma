import {
  AppError,
  LIMITS,
  PLATFORM_IMPORT_LIMITS,
  platformAddress,
  type AirtableImportProgress,
  type ImportPlatform,
  type PlatformBase,
  type PlatformBasesRequest,
  type PlatformImport,
  type PlatformImportRequest,
  type PlatformPreview,
} from '@riosoma/contracts';
import type { FastifyInstance } from 'fastify';
import { systemResolve, type Resolve } from '../../../automations/outbound.js';
import type { Actor } from '../../../http/policy.js';
import { allowsPrivate } from '../../../webhooks/url.js';
import { RateLimiter, systemClock, type Clock } from '../core/clock.js';
import type { FileLimits } from '../core/files.js';
import { ReportBuilder } from '../core/report.js';
import { ImportRunner, type ActiveImport, type ImportWork } from '../core/runner.js';
import type { ImportRow } from '../core/store.js';
import { baserowReader } from './baserow/reader.js';
import { clickupReader } from './clickup/reader.js';
import { asanaReader } from './asana/reader.js';
import { gristReader } from './grist/reader.js';
import { PlatformClient } from './http.js';
import { PlatformJob } from './job.js';
import type { PlatformSource } from './model.js';
import { planBase } from './plan.js';
import { nocodbReader } from './nocodb/reader.js';
import { notionReader } from './notion/reader.js';
import { mondayReader } from './monday/reader.js';
import { seatableReader } from './seatable/reader.js';
import { smartsheetReader } from './smartsheet/reader.js';
import { importOf, PLATFORM_TABLE } from './store.js';
import { teableReader } from './teable/reader.js';

/**
 * Runs each platform import in the background with the shared
 * import runner, the way Airtable imports run: a couple at a time, one at a time for each person,
 * the token sealed in the import's row until it starts and wiped when it ends, and what a stopped
 * import made in the trash.  Each tool has a reader that lists what a token can see and hands the
 * job its tables, records, and views.
 */

/** How a person proves who they are to the tool, as the reader uses it. */
export type Credential =
  | { kind: 'token'; token: string }
  | { kind: 'password'; email: string; password: string }
  /** Baserow's refresh token, kept in place of a password while its import runs */
  | { kind: 'refresh'; refresh: string };

export interface ReaderContext {
  platform: ImportPlatform;
  address: string;
  credential: Credential;
  /** A client for the tool, with the reader's credentials */
  client(credentials: ClientCredentials): PlatformClient;
  signal?: AbortSignal;
  fieldNames?: PlatformImportRequest['fieldNames'];
}

export interface ClientCredentials {
  credentials(): Record<string, string>;
  secrets(): string[];
  refresh?(): Promise<boolean>;
}

export interface PlatformReader {
  /** What the credentials can see, which also proves they work */
  bases(): Promise<PlatformBase[]>;
  /** What the import keeps sealed while it runs */
  kept(): Promise<Credential>;
  source(baseId: string, additionalBaseIds?: readonly string[]): PlatformSource;
}

export type ReaderFactory = (context: ReaderContext) => PlatformReader;

/** Hosted API quotas: task services use minute windows.  Database services use seconds. */
const REQUESTS_PER_WINDOW: Readonly<Record<ImportPlatform, number>> = {
  nocodb: 5,
  baserow: 10,
  grist: 10,
  teable: 10,
  seatable: 5,
  clickup: 100,
  asana: 150,
  notion: 3,
  monday: 5,
  // Smartsheet permits 300 reads per minute.  Four per second leaves room at minute boundaries.
  smartsheet: 4,
};

const READERS: Readonly<Record<ImportPlatform, ReaderFactory>> = {
  nocodb: nocodbReader,
  baserow: baserowReader,
  grist: gristReader,
  teable: teableReader,
  seatable: seatableReader,
  clickup: clickupReader,
  asana: asanaReader,
  notion: notionReader,
  monday: mondayReader,
  smartsheet: smartsheetReader,
};

interface Input {
  platform: ImportPlatform;
  address: string;
  baseId: string;
  name: string;
  viewName: string;
  additionalBaseIds: string[];
  fieldNames: NonNullable<PlatformImportRequest['fieldNames']>;
}

function credentialOf(request: PlatformBasesRequest): Credential {
  return request.token !== undefined
    ? { kind: 'token', token: request.token }
    : { kind: 'password', email: request.email ?? '', password: request.password ?? '' };
}

function sealable(credential: Credential): string {
  return JSON.stringify(
    credential.kind === 'token'
      ? { token: credential.token }
      : credential.kind === 'refresh'
        ? { refresh: credential.refresh }
        : {},
  );
}

function unsealed(text: string): Credential {
  const parsed = JSON.parse(text) as { token?: unknown; refresh?: unknown };
  if (typeof parsed.token === 'string') return { kind: 'token', token: parsed.token };
  if (typeof parsed.refresh === 'string') return { kind: 'refresh', refresh: parsed.refresh };
  throw new AppError('internal', 'import.platform.failed');
}

export class PlatformImporter extends ImportRunner<Input, PlatformImport> {
  /** Time as imports see it.  Tests use one that moves only when something waits. */
  clock: Clock = systemClock;
  /** How hosts are resolved.  Tests swap in their own. */
  resolve: Resolve = systemResolve;
  /** Whether an address may be on a private network */
  allowPrivate: (url: URL) => boolean;
  limits: FileLimits = {
    fileBytes: PLATFORM_IMPORT_LIMITS.fileBytes,
    totalFileBytes: PLATFORM_IMPORT_LIMITS.totalFileBytes,
  };
  /** Each tool's reader.  Tests can swap one in. */
  readers: Record<ImportPlatform, ReaderFactory> = { ...READERS };

  private readonly limiters = new Map<string, RateLimiter>();

  constructor(app: FastifyInstance) {
    super(app, {
      table: PLATFORM_TABLE,
      audit: 'imports.platform',
      sealContext: 'riosoma.imports.platform.token',
      lock: 'platform-import',
      busy: 'import.platform.busy',
      failed: 'import.platform.failed',
      label: 'platform import',
    });
    this.allowPrivate = (url) => allowsPrivate(url.href, app.ctx.config);
  }

  protected present(row: ImportRow): PlatformImport {
    return importOf(row);
  }

  /** One limiter for each tool's address, shared by every import from it, so together they keep its rate. */
  limiter(platform: ImportPlatform, address: string): RateLimiter {
    const key = `${platform} ${address}`;
    let limiter = this.limiters.get(key);
    if (!limiter) {
      limiter = new RateLimiter(
        this.clock,
        REQUESTS_PER_WINDOW[platform],
        platform === 'clickup' || platform === 'asana' ? 60_000 : 1_000,
      );
      this.limiters.set(key, limiter);
    }
    return limiter;
  }

  private reader(
    platform: ImportPlatform,
    address: string,
    credential: Credential,
    signal?: AbortSignal,
    fieldNames?: PlatformImportRequest['fieldNames'],
  ) {
    return this.readers[platform]({
      platform,
      address,
      credential,
      fieldNames,
      ...(signal ? { signal } : {}),
      client: (credentials) =>
        new PlatformClient({
          address,
          clock: this.clock,
          limiter: this.limiter(platform, address),
          resolve: this.resolve,
          allowPrivate: (url) => this.allowPrivate(url),
          ...(platform === 'smartsheet' ? { rateLimitWaitMs: 60_000 } : {}),
          ...(signal ? { signal } : {}),
          ...credentials,
        }),
    });
  }

  private check(platform: ImportPlatform, request: PlatformBasesRequest): string {
    if (request.token === undefined && platform !== 'baserow')
      throw new AppError('validation_failed', 'import.platform.tokenNeeded', {
        fields: { token: 'import.platform.tokenNeeded' },
      });
    return platformAddress(request.address);
  }

  /** What the credentials can see.  They're used for this and forgotten. */
  async bases(platform: ImportPlatform, request: PlatformBasesRequest): Promise<PlatformBase[]> {
    const address = this.check(platform, request);
    const bases = await this.reader(platform, address, credentialOf(request)).bases();
    return bases.slice(0, PLATFORM_IMPORT_LIMITS.bases);
  }

  async preview(platform: ImportPlatform, request: PlatformImportRequest): Promise<PlatformPreview> {
    const address = this.check(platform, request);
    const source = this.reader(
      platform,
      address,
      credentialOf(request),
      undefined,
      request.fieldNames,
    ).source(request.baseId, request.additionalBaseIds);
    const schema = await source.schema();
    const plan = planBase(schema);
    const report = new ReportBuilder('import.platform.report.exact');
    for (const note of schema.notes) report.add('base', null, null, note);
    for (const table of plan.tables) {
      for (const note of table.notes) report.add('table', table.name, null, note);
      for (const field of table.fields)
        for (const note of field.notes) report.add('field', table.name, field.name, note);
      for (const view of table.source.views)
        for (const note of view.notes) report.add('view', table.name, view.name, note);
    }
    return {
      tables: plan.tables.map((table) => ({
        id: table.source.id,
        name: table.name,
        views: table.source.views.filter((view) => view.kind !== null).length,
        fields: table.fields.flatMap((field) =>
          field.kind === 'omitted'
            ? []
            : [
                {
                  name: field.name,
                  type:
                    field.kind === 'value' ? field.spec.type : field.kind === 'files' ? 'attachment' : 'link',
                },
              ],
        ),
      })),
      notes: report.build({ tables: 0, fields: 0, records: 0, views: 0, files: 0 }).items,
    };
  }

  /** Starts an import, or refuses when the person already has one going. */
  async begin(
    actor: Actor,
    platform: ImportPlatform,
    request: PlatformImportRequest,
  ): Promise<PlatformImport> {
    if (actor.kind === 'guest') throw new AppError('forbidden', 'data.access.denied');
    const address = this.check(platform, request);
    await this.sweep();
    // Asking the tool for the base's name also proves the credentials work before anything waits on them.
    const reader = this.reader(platform, address, credentialOf(request));
    const bases = await reader.bases();
    const listed = bases.find((base) => base.id === request.baseId);
    if (!listed) throw new AppError('not_found', 'import.platform.baseUnavailable');
    const additionalBaseIds = [...new Set(request.additionalBaseIds ?? [])].filter(
      (id) => id !== request.baseId,
    );
    if (additionalBaseIds.length && platform !== 'clickup' && platform !== 'asana')
      throw new AppError('validation_failed', 'import.platform.baseUnavailable');
    if (additionalBaseIds.some((id) => !bases.some((base) => base.id === id)))
      throw new AppError('not_found', 'import.platform.baseUnavailable');
    const name = request.name ?? (listed.name.trim().slice(0, LIMITS.nameLength) || request.baseId);
    const kept = await reader.kept();
    return this.enqueue(
      actor,
      {
        baseId: request.baseId,
        name,
        token: sealable(kept),
        platform: { name: platform, address },
        audit: { platform },
      },
      {
        platform,
        address,
        baseId: request.baseId,
        additionalBaseIds,
        fieldNames: request.fieldNames ?? {},
        name,
        viewName: request.viewName ?? 'Grid',
      },
    );
  }

  protected work(
    active: ActiveImport<Input>,
    token: string,
    signal: AbortSignal,
    progress: (patch: Partial<AirtableImportProgress>) => Promise<void>,
  ): ImportWork {
    const { platform, address } = active.input;
    const source = this.reader(platform, address, unsealed(token), signal, active.input.fieldNames).source(
      active.input.baseId,
      active.input.additionalBaseIds,
    );
    return new PlatformJob(
      { id: active.id, ...active.input },
      {
        app: this.app,
        actor: active.actor,
        source,
        resolve: this.resolve,
        allowPrivate: (url) => this.allowPrivate(url),
        limits: this.limits,
        signal,
        progress,
      },
    );
  }
}
