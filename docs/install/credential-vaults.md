# Credential vault setup

Set `RIOSOMA_CREDENTIAL_VAULTS` to a JSON array of connection objects.  Each object needs a stable `id`, a provider `kind`, and an `endpoint`.  IDs contain letters, digits, underscores, and hyphens.  Use a new ID when changing the remote account or storage location.  Existing references keep their original connection ID.

Keep authentication material in your deployment’s secret settings.  It is never accepted through the browser or written to Riosoma’s database.  Use HTTPS for vault endpoints.  HTTP is allowed only for local loopback tests.  Requests have a ten-second deadline, refuse redirects, and discard remote error bodies.  Give the identity access only to the dedicated project, vault, mount, or secret prefix it needs.

Configure the connection, restart the server, and choose it in Settings → Where credentials live.  Configuring a connection alone does not move credentials.  A move has a preview and a persistent report.  Retain old connection definitions and wrapping keys until migration finishes and your rollback and backup retention windows expire.  Remote copies from earlier operations remain under the vault’s retention policy.

`RIOSOMA_CREDENTIAL_CACHE_SECONDS` defaults to `300`, accepts `0` through `3600`, and caches only successful reads in memory.  `0` fetches on every use.  `RIOSOMA_CREDENTIAL_ROTATE` accepts a rotation request identifier.  Change it to start another rotation.  Reusing it after a restart resumes the same request instead of creating another key.

## HashiCorp Vault and OpenBao

Use `kind: "vault"` or `kind: "openbao"`, the server’s `endpoint`, and a KV v2 `mount` such as `secret`.  An optional `namespace` sends the Vault namespace header.  The identity needs create and read access to the mount’s `data` paths and delete access to its `metadata` paths for cleanup.  Writes use create-only check-and-set so they cannot overwrite an unrelated entry.  See the [KV v2 API](https://developer.hashicorp.com/vault/api-docs/secret/kv/kv-v2).

Choose one `auth` object:

- Token: `kind: "token"` and `token`.
- AppRole: `kind: "approle"`, `roleId`, `secretId`, and optional authentication `mount`, defaulting to `approle`.
- Kubernetes: `kind: "kubernetes"`, `role`, `jwtFile`, and optional authentication `mount`, defaulting to `kubernetes`.  Mount a service-account JWT file into the server.  The file is read again for each login so projected-token rotation works.

For a remote wrapping key, add `transit: { "mount": "transit", "key": "credential-keys" }`.  Create an AES-256-GCM Transit key with derivation enabled.  Grant encrypt and decrypt access to that key.  Context and associated data bind each wrapped data key to its credential.  Rotate the Transit key at the provider first, then select this connection under Key encryption key to rewrap existing envelopes with its current version.  See the [Transit API](https://developer.hashicorp.com/vault/api-docs/secret/transit).

## AWS Secrets Manager

Use `kind: "aws"`, the regional service `endpoint`, `region`, `accessKeyId`, `secretAccessKey`, and optional `sessionToken`.  The identity needs `CreateSecret`, `GetSecretValue`, and `DeleteSecret` on the dedicated credential prefix.  Requests use Signature Version 4.  Secret names start with `rio-` and random identifiers.  See [CreateSecret](https://docs.aws.amazon.com/secretsmanager/latest/apireference/API_CreateSecret.html).

For KMS wrapping, add `kms` with its regional `endpoint` and `keyId`.  Grant `kms:Encrypt` and `kms:Decrypt`.  Riosoma supplies an encryption context for every data key.  Select a connection naming the new KMS key when changing keys.  Keep old key versions available during and after rewrapping.  See [KMS Encrypt](https://docs.aws.amazon.com/kms/latest/APIReference/API_Encrypt.html).

## Google Secret Manager

Use `kind: "google"`, the Secret Manager `endpoint`, `project`, the OAuth `tokenEndpoint`, `clientEmail`, `privateKey`, and optional `keyId`.  These identity values come from the service-account key document.  Grant secret creation, version creation, version access, and deletion within the selected project.  Riosoma signs an RS256 service-account assertion and exchanges it for a short-lived access token.  Each reference pins the returned secret version.  See [secret versions](https://cloud.google.com/secret-manager/docs/reference/rest/v1/projects.secrets/addVersion).

## Azure Key Vault

Use `kind: "azure"` and the vault’s `endpoint`.  Grant secret set, get, and delete permissions.  Choose one `auth` object:

- Client credentials: `kind: "client"`, the tenant’s OAuth v2 `tokenEndpoint`, `clientId`, and `clientSecret`.
- Managed identity: `kind: "managed"` and optional `clientId` for a user-assigned identity.  The default uses the instance metadata identity endpoint.  For App Service or Container Apps, supply the platform’s `identityEndpoint` and `identityHeader` in server configuration.

Managed identity token requests use the vault resource audience.  Client credentials use its `.default` scope.  References pin the version returned by the vault.  See [Set Secret](https://learn.microsoft.com/en-us/rest/api/keyvault/secrets/set-secret/set-secret).

## Infisical

Use `kind: "infisical"`, the API `endpoint`, `projectId`, `environment`, optional `secretPath`, `clientId`, and `clientSecret`.  Create a machine identity with Universal Auth and access to create, read, and delete secrets in that environment and folder.  The secret path defaults to `/`.  Reads disable reference expansion.  See [the secrets API](https://infisical.com/docs/api-reference/endpoints/secrets/create).

## Doppler

Use `kind: "doppler"`, the API `endpoint`, `project`, `config`, and a read/write service `token`.  Secret names use the random credential identifier in uppercase with underscores.  Give the token access only to the dedicated configuration.  See [Update secrets](https://docs.doppler.com/reference/secrets-update).

## Bitwarden Secrets Manager

Use `kind: "bitwarden"`, the API `endpoint`, `identityEndpoint`, `organizationId`, `projectId`, and a machine account `accessToken`.  The API endpoint includes the deployment’s API base path when required.  Give the machine account read/write access to the selected project.

The access token includes both authentication and decryption material.  Riosoma derives its wrapping key, authenticates the returned encrypted organization key, and encrypts secret fields before sending them.  The complete access token must stay in server secret settings.  See [secret decryption](https://bitwarden.com/help/secret-decryption/).

## 1Password Connect

Use `kind: "onepassword"`, the Connect server `endpoint`, `vaultId`, and an access `token` with read/write access to that vault.  Credential envelopes occupy a concealed field in an API credential item.  References use the item ID returned by Connect.  See [the Connect API](https://developer.1password.com/docs/connect/api-reference/).

## Tests

The adapter suite uses local HTTP servers and runtime-generated credentials.  `ops/test-fleet/credential-vaults.sh` starts isolated Vault and OpenBao services from the fleet images, runs their live tests, and removes its resources.  Cloud live tests read `RIOSOMA_CREDENTIAL_TEST_PROFILES`, a JSON array using the same connection format, and skip when it is absent.  Use dedicated test identities with create, read, and delete permissions.  Test entries use random names and are deleted afterward.  Azure soft-delete retention follows the vault’s policy.
