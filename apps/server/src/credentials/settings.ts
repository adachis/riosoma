import { z } from 'zod';

const text = z.string().min(1).max(16384);
const segment = z
  .string()
  .regex(/^[A-Za-z0-9_-]+$/)
  .max(200);
const path = z
  .string()
  .regex(/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/)
  .max(500);
const endpoint = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return (
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      (url.protocol === 'https:' ||
        (url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname)))
    );
  });
const common = { id: segment, endpoint };
const vault = {
  ...common,
  mount: path.default('secret'),
  namespace: text.optional(),
  auth: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('token'), token: text }),
    z.object({ kind: z.literal('approle'), mount: path.default('approle'), roleId: text, secretId: text }),
    z.object({ kind: z.literal('kubernetes'), mount: path.default('kubernetes'), role: text, jwtFile: text }),
  ]),
  transit: z.object({ mount: path.default('transit'), key: segment }).optional(),
};

export const VaultProfile = z.discriminatedUnion('kind', [
  z.object({ ...vault, kind: z.literal('vault') }),
  z.object({ ...vault, kind: z.literal('openbao') }),
  z.object({
    ...common,
    kind: z.literal('aws'),
    region: segment,
    accessKeyId: text,
    secretAccessKey: text,
    sessionToken: text.optional(),
    kms: z.object({ endpoint, keyId: text }).optional(),
  }),
  z.object({
    ...common,
    kind: z.literal('google'),
    project: segment,
    tokenEndpoint: endpoint,
    clientEmail: text,
    privateKey: text,
    keyId: text.optional(),
  }),
  z.object({
    ...common,
    kind: z.literal('azure'),
    auth: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('client'), tokenEndpoint: endpoint, clientId: text, clientSecret: text }),
      z.object({
        kind: z.literal('managed'),
        clientId: text.optional(),
        identityEndpoint: z.string().url().default('http://169.254.169.254/metadata/identity/oauth2/token'),
        identityHeader: text.optional(),
      }),
    ]),
  }),
  z.object({
    ...common,
    kind: z.literal('infisical'),
    projectId: text,
    environment: segment,
    secretPath: text.default('/'),
    clientId: text,
    clientSecret: text,
  }),
  z.object({ ...common, kind: z.literal('doppler'), project: segment, config: segment, token: text }),
  z.object({
    ...common,
    kind: z.literal('bitwarden'),
    identityEndpoint: endpoint,
    accessToken: text,
    organizationId: text,
    projectId: text,
  }),
  z.object({ ...common, kind: z.literal('onepassword'), vaultId: segment, token: text }),
]);
export type VaultProfile = z.infer<typeof VaultProfile>;
export type ProfileOf<K extends VaultProfile['kind']> = Extract<VaultProfile, { kind: K }>;

export const VaultProfiles = z
  .array(VaultProfile)
  .max(50)
  .refine(
    (profiles) =>
      new Set(profiles.map((profile) => profile.id)).size === profiles.length &&
      profiles.every((profile) => profile.id !== 'database'),
  );

export interface CredentialSettings {
  profiles: VaultProfile[];
  cacheSeconds: number;
  rotateOnStartup?: string;
}
