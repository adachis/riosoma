import { z } from 'zod';

/**
 * How Riosoma reaches its PostgreSQL server.  One profile covers every security setup: a plain
 * password on a laptop, TLS with a private CA and client certificates, cloud identity tokens that
 * replace passwords (Azure Entra, AWS RDS IAM, Google Cloud SQL IAM), an SSH bastion in front of a
 * private network, and connection poolers that can't hold session state.
 */
export const TLS_MODES = ['disable', 'prefer', 'require', 'verify-ca', 'verify-full'] as const;

export const DatabaseAuth = z.discriminatedUnion('method', [
  z.object({ method: z.literal('password'), password: z.string().min(1) }),
  z.object({
    method: z.literal('azure-entra'),
    /** managed identity, workload identity, or a service principal secret/certificate */
    credential: z.enum(['managed-identity', 'workload-identity', 'service-principal']),
    clientId: z.string().optional(),
    tenantId: z.string().optional(),
    clientSecret: z.string().optional(),
    certificatePem: z.string().optional(),
  }),
  z.object({ method: z.literal('aws-rds-iam'), region: z.string().min(1) }),
  z.object({ method: z.literal('gcp-cloudsql-iam'), instanceConnectionName: z.string().min(1) }),
  z.object({ method: z.literal('client-certificate') }),
]);
export type DatabaseAuth = z.infer<typeof DatabaseAuth>;

export const DatabaseTls = z.object({
  mode: z.enum(TLS_MODES).default('verify-full'),
  /** PEM bundle of trusted roots; the platform store is used when absent */
  caPem: z.string().optional(),
  clientCertPem: z.string().optional(),
  clientKeyPem: z.string().optional(),
  /** Hostname to verify against when connecting through a tunnel or an IP address */
  serverName: z.string().optional(),
});
export type DatabaseTls = z.infer<typeof DatabaseTls>;

export const SshTunnel = z.object({
  host: z.string().min(1),
  port: z.number().int().positive().default(22),
  user: z.string().min(1),
  privateKeyPem: z.string().min(1),
  passphrase: z.string().optional(),
  /** Pinned host key (OpenSSH "type base64" form); connections fail closed when it doesn't match */
  hostKey: z.string().min(1),
});
export type SshTunnel = z.infer<typeof SshTunnel>;

export const SCHEMA_NAME = /^[a-z_][a-z0-9_]{1,62}$/;

export const DatabaseProfile = z.object({
  host: z.string().min(1),
  port: z.number().int().positive().default(5432),
  database: z.string().min(1),
  user: z.string().min(1),
  auth: DatabaseAuth,
  tls: DatabaseTls.default({ mode: 'verify-full' }),
  ssh: SshTunnel.optional(),
  /** Transaction poolers (PgBouncer, RDS Proxy, Supavisor) can't hold session state or LISTEN */
  pooler: z.enum(['none', 'transaction', 'session']).default('none'),
  /** A direct connection used only for LISTEN/NOTIFY when the main one goes through a pooler */
  listenHost: z.string().optional(),
  listenPort: z.number().int().positive().optional(),
  schemas: z
    .object({
      app: z.string().regex(SCHEMA_NAME).default('rio_app'),
      data: z.string().regex(SCHEMA_NAME).default('rio_data'),
      audit: z.string().regex(SCHEMA_NAME).default('rio_audit'),
    })
    .default({ app: 'rio_app', data: 'rio_data', audit: 'rio_audit' }),
  pool: z
    .object({ max: z.number().int().positive().default(10), idleTimeoutMs: z.number().int().default(30_000) })
    .default({ max: 10, idleTimeoutMs: 30_000 }),
  applicationName: z.string().default('riosoma'),
});
export type DatabaseProfile = z.infer<typeof DatabaseProfile>;
