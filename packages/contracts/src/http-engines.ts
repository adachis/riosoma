import { z } from 'zod';

/**
 * Connections for the sources reached over HTTP with JSON: two search engines that speak the same
 * query DSL, two that take their own filter syntax, a graph database, and two time-series stores.
 * They live apart from the rest of `sources.ts` because they share one shape for an address, a
 * sign-in, and an optional certificate authority, and each engine adds only what it needs.
 */

/** An address with no sign-in in it, no query, and no fragment, so secrets never ride along. */
const Endpoint = z
  .string()
  .url()
  .max(2_000)
  .refine((value) => {
    if (!URL.canParse(value)) return false;
    const url = new URL(value);
    return (
      ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash
    );
  });
const Base = z.object({
  endpoint: Endpoint,
  user: z.string().max(255).default(''),
  caPem: z.string().max(64_000).optional(),
});
const Search = Base.extend({
  auth: z.enum(['none', 'api-key', 'basic']).default('api-key'),
});
export const ElasticsearchConnection = Search.extend({ kind: z.literal('elasticsearch') });
export const OpenSearchConnection = Base.extend({
  kind: z.literal('opensearch'),
  auth: z.enum(['none', 'api-key', 'basic', 'aws-sigv4']).default('basic'),
  region: z
    .string()
    .regex(/^[a-z]{2}(?:-[a-z]+)+-\d$/)
    .default('us-east-1'),
  service: z.enum(['es', 'aoss']).default('es'),
});
export const MeilisearchConnection = Search.extend({ kind: z.literal('meilisearch') });
export const TypesenseConnection = Search.extend({ kind: z.literal('typesense') });
export const Neo4jConnection = Base.extend({
  kind: z.literal('neo4j'),
  auth: z.enum(['none', 'basic']).default('basic'),
  database: z.string().min(1).max(255).default('neo4j'),
});
const Window = {
  windowMinutes: z.number().int().min(1).max(525_600).default(60),
  start: z.iso.datetime({ offset: true }).optional(),
  end: z.iso.datetime({ offset: true }).optional(),
};
export const InfluxDbConnection = Base.extend({
  kind: z.literal('influxdb'),
  auth: z.enum(['none', 'token']).default('token'),
  version: z.enum(['2', '3']).default('2'),
  database: z.string().min(1).max(255),
  organization: z.string().max(255).default(''),
  ...Window,
});
export const PrometheusConnection = Base.extend({
  kind: z.literal('prometheus'),
  auth: z.enum(['none', 'basic', 'token']).default('none'),
  query: z.string().trim().min(1).max(20_000),
  stepSeconds: z.number().int().min(1).max(86_400).default(60),
  ...Window,
});

/** Any of the seven, once parsed, for the code that reads what they hold in common. */
export type HttpEngineConnection =
  | z.infer<typeof ElasticsearchConnection>
  | z.infer<typeof OpenSearchConnection>
  | z.infer<typeof MeilisearchConnection>
  | z.infer<typeof TypesenseConnection>
  | z.infer<typeof Neo4jConnection>
  | z.infer<typeof InfluxDbConnection>
  | z.infer<typeof PrometheusConnection>;
