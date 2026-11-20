import { budgetReached } from './budget.js';
import { aiDestination, AppError, type KnowledgeSettings, type SearchSource } from '@riosoma/contracts';
import { z } from 'zod';
import { isGateway, providerFor } from '@riosoma/ai';
import type { AppContext } from '../app.js';
import { callOut, systemResolve, type OutboundRequest } from '../automations/outbound.js';
import type { Actor } from '../http/policy.js';
import { knowledgeSettings } from '../data/knowledge.js';
import { credential, recordKnowledgeUse } from '../data/knowledge-usage.js';
import { zoneFor } from './footprint.js';
import { connection, settingsFor, spent } from './settings.js';

export const Vector = z
  .array(z.number().finite())
  .min(1)
  .max(4096)
  .refine(
    (values) =>
      values.reduce((sum, value) => sum + value * value, 0) > 0 &&
      Number.isFinite(values.reduce((sum, value) => sum + value * value, 0)),
  )
  .transform((values) => {
    const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
    return values.map((value) => value / norm);
  });
const failed = () => new AppError('unavailable', 'knowledge.requestFailed');

function sameOrigin(one: string, other: string): boolean {
  try {
    return new URL(one).origin === new URL(other).origin;
  } catch {
    return false;
  }
}

/** Whether an address is another one or sits under it, as the URL standard reads their paths. */
function within(base: string, address: string): boolean {
  const outer = aiDestination(base);
  const inner = aiDestination(address);
  return outer !== null && inner !== null && (inner === outer || inner.startsWith(`${outer}/`));
}

async function available(ctx: AppContext, actor: Actor) {
  const settings = await settingsFor(ctx, actor.orgId, actor);
  if (!settings.enabled) throw new AppError('forbidden', 'rio.disabled');
  if (
    settings.monthlyBudgetUsd !== null &&
    budgetReached(await spent(ctx, actor.orgId), settings.monthlyBudgetUsd)
  )
    throw new AppError('unavailable', 'rio.paused');
  return settings;
}

async function json(request: OutboundRequest, privateService: boolean, signal?: AbortSignal) {
  const response = await callOut(request, {
    resolve: systemResolve,
    signal,
    allowPrivate: privateService,
    responseLimit: 1024 * 1024,
    timeoutMs: 15000,
  });
  if (response.status < 200 || response.status >= 300 || response.truncated) throw failed();
  try {
    return JSON.parse(response.body) as unknown;
  } catch {
    throw failed();
  }
}

export async function embed(
  ctx: AppContext,
  actor: Actor,
  settings: KnowledgeSettings,
  input: string[],
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const ref = settings.embedding;
  const allowed = await available(ctx, actor);
  if (!ref || !allowed.providers.some((entry) => entry.providerId === ref.providerId))
    throw new AppError('unavailable', 'knowledge.embeddingUnavailable');
  if (!input.length || input.length > 32 || input.some((text) => Buffer.byteLength(text) > 16000))
    throw failed();
  const provider = providerFor(ref.providerId);
  const connected = await connection(ctx, actor.orgId, ref.providerId, allowed);
  if (!connected.available) throw failed();
  let tokens = 0;
  const started = performance.now();
  try {
    if (isGateway(ref.providerId) && connected.adapter.embed) {
      const reply = await connected.adapter.embed(connected.config, ref.model, input, signal);
      tokens = reply.inputTokens;
      return reply.vectors.map((vector) => Vector.parse(vector));
    }
    // The provider's key goes with the request only when the embedding address is the provider's,
    // never to another address the settings name.  A key saved for an address the organization
    // chose goes at or under that address, since services that share a host tell accounts apart by
    // path.  The provider's own host is all the provider's, so the host is enough there.
    const chosen = connected.config.baseUrl;
    const own = chosen
      ? within(chosen, ref.address)
      : Boolean(provider.baseUrl) && sameOrigin(provider.baseUrl!, ref.address);
    const apiKey = own ? connected.config.apiKey : undefined;
    const response = await json(
      {
        url: `${ref.address.replace(/\/+$/, '')}/${ref.protocol === 'local' ? 'api/embed' : 'embeddings'}`,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({ model: ref.model, input }),
      },
      provider.local,
      signal,
    );
    const parsed = z
      .object({
        embeddings: z.array(Vector).optional(),
        data: z.array(z.object({ index: z.number().int().min(0), embedding: Vector })).optional(),
        usage: z.object({ prompt_tokens: z.number().int().nonnegative() }).optional(),
        prompt_eval_count: z.number().int().nonnegative().optional(),
      })
      .parse(response);
    tokens = parsed.usage?.prompt_tokens ?? parsed.prompt_eval_count ?? 0;
    const vectors =
      ref.protocol === 'local'
        ? parsed.embeddings
        : parsed.data
            ?.sort((a, b) => a.index - b.index)
            .map((row, index) => {
              if (row.index !== index) throw failed();
              return row.embedding;
            });
    if (!vectors || vectors.length !== input.length || vectors.some((v) => v.length !== vectors[0]!.length))
      throw failed();
    return vectors;
  } catch {
    throw failed();
  } finally {
    await recordKnowledgeUse(ctx, actor, 'embedding', ref.providerId, ref.model, tokens, {
      powerWatts: ref.powerWatts,
      durationMs: performance.now() - started,
      zone: zoneFor(ctx, allowed),
    });
  }
}

export function sourceUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

export function readablePage(text: string) {
  return text
    .replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(?:nbsp|amp|lt|gt|quot);/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 8000);
}

export async function searchWeb(ctx: AppContext, actor: Actor, input: { query: string; readPages: boolean }) {
  const allowed = await available(ctx, actor);
  const { search } = await knowledgeSettings(ctx, actor);
  if (!search.enabled || !search.address) throw new AppError('unavailable', 'knowledge.searchUnavailable');
  const url = new URL(search.address);
  const headers: Record<string, string> = { accept: 'application/json' };
  let body: string | null = null;
  if (search.engine === 'research') {
    headers.authorization = `Bearer ${await credential(ctx, actor, 'search-research', search.address)}`;
    headers['content-type'] = 'application/json';
    body = JSON.stringify({ query: input.query, max_results: 5, include_answer: false });
  } else {
    url.searchParams.set('q', input.query);
    if (search.engine === 'searxng') {
      url.pathname = `${url.pathname.replace(/\/+$/, '')}/search`;
      url.searchParams.set('format', 'json');
    } else {
      url.searchParams.set('count', '5');
      headers['X-Subscription-Token'] = await credential(ctx, actor, 'search-subscription', search.address);
    }
  }
  const started = performance.now();
  let durationMs: number | undefined;
  try {
    const raw = await json(
      { url: url.href, method: body ? 'POST' : 'GET', headers, body },
      search.engine === 'searxng',
    );
    durationMs = performance.now() - started;
    const result = z
      .object({
        results: z.array(z.unknown()).optional(),
        web: z.object({ results: z.array(z.unknown()) }).optional(),
      })
      .parse(raw);
    const sources: SearchSource[] = [];
    for (const item of (result.results ?? result.web?.results ?? []).slice(0, 20)) {
      const row = z
        .object({
          url: z.string(),
          title: z.string(),
          content: z.string().optional(),
          description: z.string().optional(),
        })
        .safeParse(item);
      if (!row.success) continue;
      const address = sourceUrl(row.data.url);
      if (!address || sources.some((source) => source.url === address)) continue;
      sources.push({
        url: address,
        title: readablePage(row.data.title).slice(0, 300),
        text: readablePage(row.data.content ?? row.data.description ?? '').slice(0, 2000),
      });
      if (sources.length === 5) break;
    }
    if (input.readPages)
      for (const source of sources.slice(0, 3)) {
        try {
          // Result addresses always use public-only fetching, regardless of the configured service.
          const page = await callOut(
            { url: source.url, method: 'GET', headers: { accept: 'text/html, text/plain' }, body: null },
            { resolve: systemResolve, allowPrivate: false, responseLimit: 65536, timeoutMs: 10000 },
          );
          if (page.status >= 200 && page.status < 300) source.text = readablePage(page.body);
        } catch {
          /* A blocked page keeps its search snippet and source. */
        }
      }
    return { untrusted: true, sources };
  } catch {
    throw failed();
  } finally {
    await recordKnowledgeUse(ctx, actor, 'search', search.engine, 'search', 0, {
      powerWatts: search.powerWatts,
      durationMs: durationMs ?? performance.now() - started,
      zone: zoneFor(ctx, allowed),
    });
  }
}
