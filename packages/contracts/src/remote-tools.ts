import { z } from 'zod';

export const RemoteAudience = z.object({
  everyone: z.boolean().default(false),
  groups: z.array(z.string().min(1).max(100)).max(100).default([]),
  units: z.array(z.string().min(1).max(100)).max(100).default([]),
  roles: z
    .array(
      z.enum([
        'owner',
        'member',
        'guest',
        'ai',
        'people',
        'security',
        'data_sources',
        'integrations',
        'audit',
        'feedback',
      ]),
    )
    .max(10)
    .default([]),
});
export type RemoteAudience = z.infer<typeof RemoteAudience>;
export const RemoteServerConfig = z.object({
  name: z.string().trim().min(1).max(80),
  address: z
    .string()
    .url()
    .max(2000)
    .refine((value) => {
      let url: URL;
      try {
        url = new URL(value);
      } catch {
        return false;
      }
      const host = url.hostname.replace(/^\[(.*)\]$/, '$1');
      const local =
        host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1' || host === '::1';
      return (
        (url.protocol === 'https:' || (url.protocol === 'http:' && local)) &&
        !url.username &&
        !url.password &&
        !url.hash
      );
    }),
  auth: z.enum(['none', 'header', 'oauth']),
  header: z
    .string()
    .regex(/^[a-zA-Z0-9-]+$/)
    .max(100)
    .default('Authorization')
    .refine(
      (value) =>
        ![
          'host',
          'cookie',
          'connection',
          'content-length',
          'transfer-encoding',
          'proxy-authorization',
        ].includes(value.toLowerCase()),
    ),
  allowPrivate: z.boolean().default(false),
  requireApproval: z.boolean().default(false),
  alwaysAskTools: z.array(z.string().min(1).max(200)).max(100).default([]),
  audience: RemoteAudience,
  enabledTools: z.array(z.string().min(1).max(200)).max(100).default([]),
});
export type RemoteServerConfig = z.infer<typeof RemoteServerConfig>;
export interface RemoteTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnly: boolean;
}
export interface RemoteServer {
  id: string;
  config: RemoteServerConfig;
  tools: RemoteTool[];
  revision: number;
  refreshedAt: string | null;
  errorKey: string | null;
  hasCredential: boolean;
  skippedTools: { name: string; reason: string }[];
}
const id = z.string().uuid();
export const RemoteServerCommand = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('remote.save'),
    id,
    serverId: id,
    revision: z.number().int().min(0),
    config: RemoteServerConfig,
    secret: z.string().min(1).max(8000).optional(),
    clientId: z.string().min(1).max(1000).optional(),
  }),
  z.object({ kind: z.literal('remote.remove'), id, serverId: id, revision: z.number().int().positive() }),
  z.object({ kind: z.literal('remote.undo'), id, actionId: id }),
  z.object({ kind: z.literal('remote.refresh'), id, serverId: id }),
  z.object({ kind: z.literal('remote.authorize'), id, serverId: id }),
]);
export type RemoteServerCommand = z.infer<typeof RemoteServerCommand>;
export const RemoteCall = z.object({
  serverId: id,
  tool: z.string().min(1).max(200),
  arguments: z.record(z.string(), z.unknown()),
});
export type RemoteCall = z.infer<typeof RemoteCall>;
export type RemoteApproval = {
  id: string;
  server: string;
  tool: string;
  arguments: Record<string, unknown>;
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'denied';
  result?: string;
};
