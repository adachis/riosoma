import type { DatabaseProfile } from '@riosoma/contracts';

/**
 * Cloud identities hand out short-lived tokens that stand in for the database password.  A token
 * is fetched when a new connection opens and reused until shortly before it expires, so a
 * long-running server never fails a connection on an expired credential.
 */
export type PasswordSource = string | (() => Promise<string>);

interface CachedToken {
  value: string;
  expiresAt: number;
}

const REFRESH_MARGIN_MS = 5 * 60 * 1000;
const AZURE_POSTGRES_SCOPE = 'https://ossrdbms-aad.database.windows.net/.default';
const CLOUD_SQL_SCOPE = 'https://www.googleapis.com/auth/sqlservice.login';

function cached(fetcher: () => Promise<CachedToken>): () => Promise<string> {
  let current: CachedToken | null = null;
  let pending: Promise<CachedToken> | null = null;
  return async () => {
    if (current && current.expiresAt - REFRESH_MARGIN_MS > Date.now()) return current.value;
    pending ??= fetcher().finally(() => {
      pending = null;
    });
    current = await pending;
    return current.value;
  };
}

async function azureToken(
  auth: Extract<DatabaseProfile['auth'], { method: 'azure-entra' }>,
  scope = AZURE_POSTGRES_SCOPE,
): Promise<CachedToken> {
  const identity = await import('@azure/identity');
  let credential;
  switch (auth.credential) {
    case 'managed-identity':
      credential = auth.clientId
        ? new identity.ManagedIdentityCredential({ clientId: auth.clientId })
        : new identity.ManagedIdentityCredential();
      break;
    case 'workload-identity':
      credential = new identity.WorkloadIdentityCredential(
        auth.clientId && auth.tenantId ? { clientId: auth.clientId, tenantId: auth.tenantId } : {},
      );
      break;
    case 'service-principal':
      if (!auth.tenantId || !auth.clientId) throw new Error('service principal needs tenantId and clientId');
      if (auth.certificatePem) {
        credential = new identity.ClientCertificateCredential(auth.tenantId, auth.clientId, {
          certificate: auth.certificatePem,
        });
      } else if (auth.clientSecret) {
        credential = new identity.ClientSecretCredential(auth.tenantId, auth.clientId, auth.clientSecret);
      } else {
        throw new Error('service principal needs a client secret or certificate');
      }
      break;
  }
  const token = await credential.getToken(scope);
  if (!token) throw new Error(`Azure returned no token for ${scope}`);
  return { value: token.token, expiresAt: token.expiresOnTimestamp };
}

async function rdsToken(
  profile: DatabaseProfile,
  auth: Extract<DatabaseProfile['auth'], { method: 'aws-rds-iam' }>,
): Promise<CachedToken> {
  const { Signer } = await import('@aws-sdk/rds-signer');
  const signer = new Signer({
    hostname: profile.host,
    port: profile.port,
    username: profile.user,
    region: auth.region,
  });
  // RDS IAM tokens are valid for 15 minutes.
  return { value: await signer.getAuthToken(), expiresAt: Date.now() + 15 * 60 * 1000 };
}

/**
 * Cloud SQL IAM sign-in: an OAuth access token from Application Default Credentials (a key file
 * named by GOOGLE_APPLICATION_CREDENTIALS, or the metadata server on Google Cloud) stands in for
 * the password.  The database user is the IAM principal, for a service account its email without
 * `.gserviceaccount.com`.
 */
async function cloudSqlToken(): Promise<CachedToken> {
  const { GoogleAuth } = await import('google-auth-library');
  const client = await new GoogleAuth({ scopes: [CLOUD_SQL_SCOPE] }).getClient();
  const { token } = await client.getAccessToken();
  if (!token) throw new Error('Google Cloud returned no access token');
  // Access tokens last about an hour; the client knows the exact expiry when the server said.
  const expiry = client.credentials.expiry_date;
  return { value: token, expiresAt: expiry ?? Date.now() + 55 * 60 * 1000 };
}

/**
 * Tokens for another Azure service, such as Blob Storage, from the identity the server runs as:
 * AKS workload identity when the platform set it up, and otherwise a managed identity, whose
 * token comes from the instance metadata endpoint, or from the endpoint App Service and Container
 * Apps provide.  `clientId` picks a user-assigned identity.
 */
export function azureServiceToken(scope: string, clientId?: string): () => Promise<string> {
  const credential = process.env.AZURE_FEDERATED_TOKEN_FILE ? 'workload-identity' : 'managed-identity';
  return cached(() =>
    azureToken({ method: 'azure-entra', credential, ...(clientId ? { clientId } : {}) }, scope),
  );
}

/** The password, or a callback that fetches a short-lived token, for a profile. */
export function passwordSource(profile: DatabaseProfile): PasswordSource | undefined {
  const auth = profile.auth;
  switch (auth.method) {
    case 'password':
      return auth.password;
    case 'azure-entra':
      return cached(() => azureToken(auth));
    case 'aws-rds-iam':
      return cached(() => rdsToken(profile, auth));
    case 'gcp-cloudsql-iam':
      return cached(cloudSqlToken);
    case 'client-certificate':
      return undefined;
  }
}
