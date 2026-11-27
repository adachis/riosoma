// Writes docs/install/settings.md from the settings schema in apps/server/src/config.ts.
//   node tools/settings_reference.mjs           rewrite the page
//   node tools/settings_reference.mjs --check   fail when the page is stale or the install files drift
// Names, defaults, and limits come from the schema itself.  The descriptions live below, and the
// check fails when a setting has none or when one is described that the schema no longer has.  It
// also fails when docs/install/ or deploy/ names a RIOSOMA_ setting that doesn't exist (other than
// Compose's own variables and the image's build arguments), or when the Compose file doesn't pass a
// setting through to the container.
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CONFIG = 'apps/server/src/config.ts';
const OUTPUT = 'docs/install/settings.md';
const COMPOSE = 'deploy/compose/compose.yaml';
const SCANNED = ['docs/install', 'deploy'];

const GROUPS = [
  ['server', 'Server'],
  ['database', 'Database'],
  ['keys', 'Keys, setup, and stored settings'],
  ['mail', 'Sign-in and email'],
  ['files', 'Files'],
  ['limits', 'Limits and outside services'],
  ['drives', 'Cloud drives'],
  ['notifications', 'Notification delivery'],
  ['updates', 'Updates and usage counts'],
  ['image', 'Set by the image'],
];

/**
 * What each setting is for.  `secret` settings belong in the platform's secret store.  `compose`
 * is false for image settings and standalone utilities.
 */
const DETAILS = {
  RIOSOMA_DEMO_MODE: {
    group: 'server',
    text: 'Set `on` to give visitors read-only demo sessions without an account.  The demo member must be configured before startup.  Real sign-in remains at `/sign-in`.  [Public demo mode](../modules/administration/public-demo-mode/en-US.md) explains access and limits.',
  },
  RIOSOMA_DEMO_ACCOUNT: {
    group: 'server',
    text: 'Email address of an existing, active ordinary member to use for demo reads.  Owners, organization administrators, unit administrators, guests, and missing accounts refuse startup.  Required when demo mode is on.  Shape access with ordinary sharing.',
  },
  RIOSOMA_DEMO_LINK: {
    group: 'server',
    text: 'Optional HTTP or HTTPS address linked as About Riosoma in the demo banner.  Addresses containing credentials are refused.',
  },
  RIOSOMA_DEMO_ADDRESS_LIMIT: {
    group: 'limits',
    text: 'Maximum active two-hour demo sessions per network address.  IPv6 addresses share their /64.  Capacity is counted in the database across server processes.  Visitors beyond the cap are asked to try again later.',
  },
  RIOSOMA_DEMO_SESSION_LIMIT: {
    group: 'limits',
    text: 'Maximum active demo sessions for the instance, counted across server processes.  Sessions expire after two hours and use the published-site request limits per network address.',
  },
  RIOSOMA_TLS_ASK_TOKEN: {
    group: 'server',
    secret: true,
    text: 'Shared secret for the private `/internal/tls/allow` certificate permission endpoint and TLS authority assertions for site forms beside a public demo.  Use 32 through 512 letters, digits, underscores, or hyphens.  Send it in `X-TLS-Ask-Token`, or the `token` query parameter for Caddy.  The HTTPS proxy replaces `X-Riosoma-Authority-Token` with this token and `X-Riosoma-Public-Authority` with its TLS server name.  Unset refuses certificate requests and demo site form submissions.  [Custom domains](custom-domains.md) covers proxy setup.',
  },
  RIOSOMA_TLS_ASK_ADDRESSES: {
    group: 'server',
    text: 'Comma-separated IP addresses or CIDR networks allowed to call the TLS permission endpoint and attest site form authority during public demo mode.  Checked against the actual socket peer, never forwarded headers.  Empty refuses both uses.  Limit this to the HTTPS proxy and keep its network private.',
  },
  RIOSOMA_CUSTOM_DOMAIN_TARGET: {
    group: 'server',
    text: 'DNS name or IP address administrators see as the routing target for custom domains.  Defaults to the host in `RIOSOMA_BASE_URL`.  Set a dedicated proxy or load balancer target when the main host cannot accept customer domains.',
  },
  RIOSOMA_VERSION: {
    group: 'image',
    compose: false,
    text: 'The release version reported by health checks and the app.  The image sets this at build time.',
  },
  RIOSOMA_SMOKE_PROFILE: {
    group: 'database',
    compose: false,
    secret: true,
    text: 'A JSON database profile used only by the cloud database smoke utility.  It does not configure the running server.',
  },
  RIOSOMA_DATABASE_WAIT_SECONDS: {
    group: 'database',
    text: 'The startup connection budget in seconds, including connection attempts.  Unreachable databases are retried after 1 second, then 2, 4, and so on until the budget expires.  The final wait is shortened to fit.  Set `0` for one attempt without retries.  Authentication and configuration errors stop immediately.',
  },
  RIOSOMA_AUTOMATIONS_SCRIPT_MEMORY_MB: {
    group: 'limits',
    text: 'The limit in megabytes of script memory.  Invalid values and values below 16 use 64.  Fractions round down, and values above 128 are capped at 128.',
  },
  RIOSOMA_AUTOMATIONS_SCRIPT_TIMEOUT_MS: {
    group: 'limits',
    text: 'The limit in milliseconds per script.  Invalid values and values below 10 use 5000.  Fractions round down, and values above 10000 are capped at 10000.',
  },
  RIOSOMA_AUTOMATIONS_SCRIPT_OUTPUT_KB: {
    group: 'limits',
    text: 'The limit in kilobytes of script output.  Invalid values and values below 1 use 256.  Fractions round down, and values above 1024 are capped at 1024.',
  },
  RIOSOMA_SCRIPTS_TIMEOUT_MS: {
    group: 'limits',
    text: 'The limit in milliseconds of a script run from the script panel, counting only the script\'s own time and not time spent waiting for the person to answer.  Invalid values and values below 10 use 60000.  Fractions round down, and values above 600000 (10 minutes) are capped at 600000.  Panel runs share the memory and output limits above, and every run also stops after 30 minutes in all.',
  },
  RIOSOMA_OPENAI_API_KEY: {
    group: 'keys',
    secret: true,
    text: 'The provider API key for every organization.  It takes precedence over a key saved in the app.  It is only ever sent to the provider\'s own address, so an organization can\'t choose another address for the provider while it is set.  Empty or whitespace-only values use the saved key instead.',
  },
  RIOSOMA_ANTHROPIC_API_KEY: {
    group: 'keys',
    secret: true,
    text: 'The provider API key for every organization.  It takes precedence over a key saved in the app.  It is only ever sent to the provider\'s own address, so an organization can\'t choose another address for the provider while it is set.  Empty or whitespace-only values use the saved key instead.',
  },
  RIOSOMA_GEMINI_API_KEY: {
    group: 'keys',
    secret: true,
    text: 'The provider API key for every organization.  It takes precedence over a key saved in the app.  It is only ever sent to the provider\'s own address, so an organization can\'t choose another address for the provider while it is set.  Empty or whitespace-only values use the saved key instead.',
  },
  RIOSOMA_MISTRAL_API_KEY: {
    group: 'keys',
    secret: true,
    text: 'The provider API key for every organization.  It takes precedence over a key saved in the app.  It is only ever sent to the provider\'s own address, so an organization can\'t choose another address for the provider while it is set.  Empty or whitespace-only values use the saved key instead.',
  },
  RIOSOMA_OPENROUTER_API_KEY: {
    group: 'keys',
    secret: true,
    text: 'The provider API key for every organization.  It takes precedence over a key saved in the app.  It is only ever sent to the provider\'s own address, so an organization can\'t choose another address for the provider while it is set.  Empty or whitespace-only values use the saved key instead.',
  },
  RIOSOMA_OLLAMA_API_KEY: {
    group: 'keys',
    secret: true,
    text: 'The local provider\'s API key for every organization, for a model server that asks for one.  It takes precedence over a key saved in the app.  It is only ever sent to the provider\'s built-in address, `http://localhost:11434/v1`, so an organization can\'t choose another address for the provider while it is set.  For a model server on another host, leave this unset and save the key in the app together with the server\'s address.  Empty or whitespace-only values use the saved key instead.',
  },
  RIOSOMA_ANTHROPIC_WORKSPACE_ID: {
    group: 'keys',
    text: 'The workspace routing value sent with provider requests.  Empty or whitespace-only values omit the routing header.',
  },
  RIOSOMA_SEARCH_URL: {
    group: 'limits',
    text: 'The base address of a self-hosted search service.  When configured, web search is available by default.  Organization administrators can choose another address or turn search off in Memory and search settings.',
  },
  RIOSOMA_AI_ELECTRICITY_ZONE: {
    group: 'limits',
    text: 'The electricity zone AI footprint estimates use for their carbon figures: an ISO 3166-1 alpha-3 country code such as `FRA`, `WOR` for the world average, or `EEE` for Europe, in any case.  The zone must be one the estimate method has an electricity mix for, or the server doesn\'t start.  An admin can pick a different zone for an organization in the AI settings.  Energy figures don\'t depend on the zone.',
  },

  RIOSOMA_PORT: {
    group: 'image',
    compose: false,
    text: 'The port the server listens on.  The image sets 8080, and the install files expect it there.',
  },
  RIOSOMA_HOST: {
    group: 'server',
    compose: false,
    text: 'The address the server listens on.  Running from source behind a proxy on the same machine, `127.0.0.1` keeps it off the network.',
  },
  RIOSOMA_BASE_URL: {
    group: 'server',
    text: 'The address people use to reach Riosoma, such as `https://riosoma.example.com`, with no path.  Emailed links, the setup link, and the check on where live-update connections come from all use it.  OAuth apps also take their issuer and resource addresses from it, and stay off unless it uses HTTPS or a loopback address.  Unset, setup keeps the address the owner used and stores it in the config directory.',
  },
  RIOSOMA_TRUST_PROXY: {
    group: 'server',
    text: 'Which proxies may report the client address and scheme through `X-Forwarded-For` and `X-Forwarded-Proto`.  Empty trusts none.  Accepts a hop count (`1` for a single load balancer or ingress), or a comma-separated list of addresses, CIDR ranges, and the named ranges `loopback`, `linklocal`, and `uniquelocal`.  Behind a proxy that ends TLS, set it, or sign-in cookies aren\'t marked secure and rate limits see the proxy instead of the person.',
  },
  RIOSOMA_LOG_LEVEL: {
    group: 'server',
    text: 'How much the server logs.  Logs are JSON lines on standard output, and never include credentials or anyone\'s data.',
  },
  NODE_ENV: {
    group: 'image',
    compose: false,
    text: 'Leave it at `production`.  Other values turn on development behavior: readable logs that need development packages the image doesn\'t have, no `Strict-Transport-Security` header, and plain-HTTP webhooks to local addresses.',
  },
  RIOSOMA_DATABASE_URL: {
    group: 'database',
    secret: true,
    text: 'The PostgreSQL 14 or later database, as `postgres://user:password@host:5432/database?sslmode=verify-full`.  `sslmode` is one of `disable`, `prefer` (the default), `require`, `verify-ca`, and `verify-full`, and `pooler=transaction` tells Riosoma a transaction pooler sits in front.  Percent-encode special characters in the password.  Set here, it replaces the setup wizard\'s database step.  See [the database guide](database.md).',
  },
  RIOSOMA_DATABASE_PROFILE: {
    group: 'database',
    secret: true,
    text: 'The database as a JSON profile, for anything a URL can\'t say: a private certificate authority, client certificates, cloud identity sign-in, an SSH tunnel, custom schema names, or the pool size.  It wins over `RIOSOMA_DATABASE_URL`.  See [the database guide](database.md).',
  },
  RIOSOMA_DB_QUERY_TIMEOUT_MS: {
    group: 'database',
    text: 'How long the server waits for one database query, in milliseconds.  Statements and lock waits have their own limits of 30 and 10 seconds, and migrations get 10 minutes each.',
  },
  RIOSOMA_SNAPSHOT_CACHE_MB: {
    group: 'database',
    text: 'Memory, in megabytes, for the row order of open views (row numbers only, never values).  The grid and the REST API each get this much, and shared views and interfaces a quarter each, so allow about two and a half times this in the memory limit.  `0` turns the cache off.',
  },
  RIOSOMA_CREDENTIAL_VAULTS: {
    group: 'keys', secret: true,
    text: 'JSON array of named credential vault connections.  Credentials stay in server configuration, never in the database or browser.  See [credential vault setup](credential-vaults.md).',
  },
  RIOSOMA_CREDENTIAL_CACHE_SECONDS: {
    group: 'keys',
    text: 'How long external credential reads may stay in memory, in seconds.  Defaults to 300.  Set 0 to fetch on every use.  Failed reads never reuse expired entries.',
  },
  RIOSOMA_CREDENTIAL_ROTATE: {
    group: 'keys',
    text: 'An operator-chosen rotation request identifier.  A new identifier starts a resumable wrapping-key rotation for each organization.  Keeping the same value across restarts resumes the same request.',
  },
  RIOSOMA_SECRET_KEY: {
    group: 'keys',
    secret: true,
    text: 'Thirty-two random bytes, base64-encoded (`openssl rand -base64 32`).  It seals the credentials Riosoma stores and signs its cookies.  Unset, the server makes one on first start and keeps it in the config directory.  Set it wherever that directory doesn\'t last or several replicas share a database, and never change it afterward: credentials sealed with the old key can\'t be read.',
  },
  RIOSOMA_SETUP_TOKEN: {
    group: 'keys',
    secret: true,
    text: 'A fixed first-run setup token (16 or more of `A-Z`, `a-z`, `0-9`, `-`, and `_`) instead of a generated one.  With it set, the server doesn\'t print the setup link, so open `<base URL>/setup#token=<token>` yourself.  Useful when several replicas start before setup is done.  It stops working once the owner exists.',
  },
  RIOSOMA_CONFIG_DIR: {
    group: 'keys',
    compose: false,
    text: 'Where the server keeps `riosoma.config.json`: the generated secret key, a database chosen in the setup wizard (sealed with the key), the setup token until setup finishes, and the base URL setup captured.  The image sets `/config` and declares it a volume.  Running from source, point it at a directory only the server\'s account can read.',
  },
  RIOSOMA_SESSION_IDLE_DAYS: {
    group: 'mail',
    text: 'Days a sign-in lasts without being used.',
  },
  RIOSOMA_SESSION_MAX_DAYS: {
    group: 'mail',
    text: 'Days a sign-in lasts at most, however often it\'s used.',
  },
  RIOSOMA_SMTP_URL: {
    group: 'mail',
    secret: true,
    text: 'The mail server for one-time sign-in links, invitations, and notifications: `smtps://user:password@smtp.example.com:465` for TLS from the start, or `smtp://user:password@smtp.example.com:587`, which must upgrade with STARTTLS.  While `RIOSOMA_MAIL_TRANSPORT` is at its default `smtp`, email is off unless this and `RIOSOMA_MAIL_FROM` are both set.  See [Email](email.md).',
  },
  RIOSOMA_SMTP_ALLOW_PLAINTEXT: {
    group: 'mail',
    text: 'Lets `smtp://` deliver without TLS.  Only for a local test mail catcher, and the server logs a warning while it\'s on.',
  },
  RIOSOMA_MAIL_FROM: {
    group: 'mail',
    text: 'The sender on email Riosoma sends, such as `Riosoma <riosoma@example.com>`, whatever the transport.  Every provider needs the address verified or allowed there.  `graph` and `gmail` also name the mailbox they send from, since it has to be a bare address.',
  },
  RIOSOMA_MAIL_TRANSPORT: {
    group: 'mail',
    text: 'How email goes out: `smtp` through the server named by `RIOSOMA_SMTP_URL`, `ses` through Amazon SES, `acs` through Azure Communication Services, `graph` through Microsoft Graph and a mailbox in Exchange Online, `gmail` through the Gmail API and a Google Workspace mailbox, or `relay` through an HTTPS address of your own that hands the message on.  Any transport but `smtp` stops the server at start when a setting it needs is missing, rather than failing on the first message.  See [Email](email.md).',
  },
  RIOSOMA_SES_REGION: {
    group: 'mail',
    text: 'The Amazon SES region email is sent from, such as `eu-west-1`, which is also the region each request is signed for.  The address in `RIOSOMA_MAIL_FROM` has to be verified there, and the server needs outbound HTTPS to `email.<region>.amazonaws.com`.',
  },
  RIOSOMA_SES_ACCESS_KEY_ID: {
    group: 'mail',
    text: 'The access key ID requests are signed with.  Leave this and `RIOSOMA_SES_SECRET_ACCESS_KEY` out to sign with the role of the instance or task Riosoma runs as, read from the standard AWS environment and container credential variables, which is the better choice on AWS.',
  },
  RIOSOMA_SES_SECRET_ACCESS_KEY: {
    group: 'mail',
    secret: true,
    text: 'The secret access key that goes with `RIOSOMA_SES_ACCESS_KEY_ID`.  Signing needs both or neither.',
  },
  RIOSOMA_ACS_CONNECTION_STRING: {
    group: 'mail',
    secret: true,
    text: 'An Azure Communication Services resource\'s connection string, which carries its access key and its endpoint.  Leave it out to sign in with the server\'s managed identity instead, which needs the Communication and Email Service Owner role, or Contributor, on the resource, and name the endpoint with `RIOSOMA_ACS_ENDPOINT`.',
  },
  RIOSOMA_ACS_ENDPOINT: {
    group: 'mail',
    text: 'The resource\'s endpoint, such as `https://<resource>.<region>.communication.azure.com`, as an `https` address with no path.  Read from the connection string when there is one, and needed on its own for a managed identity.  Set both and this one wins.',
  },
  RIOSOMA_GRAPH_TENANT_ID: {
    group: 'mail',
    text: 'The Microsoft Entra tenant the app registration lives in, as its directory (tenant) ID.',
  },
  RIOSOMA_GRAPH_CLIENT_ID: {
    group: 'mail',
    text: 'The application (client) ID of the app registration that sends the mail.',
  },
  RIOSOMA_GRAPH_CLIENT_SECRET: {
    group: 'mail',
    secret: true,
    text: 'A client secret of that app registration.  A certificate isn\'t accepted here, so give the secret an expiry and replace it before then.',
  },
  RIOSOMA_GRAPH_SENDER: {
    group: 'mail',
    text: 'The mailbox messages are sent from, as a bare address, such as `riosoma@example.com`.  The app registration needs the `Mail.Send` application permission with admin consent, and Exchange Online RBAC for Applications, or an application access policy, should scope it to this mailbox alone.',
  },
  RIOSOMA_GMAIL_SERVICE_ACCOUNT_JSON: {
    group: 'mail',
    secret: true,
    text: 'A Google Cloud service account\'s key file, as the JSON Google hands out, in one value with its newlines kept.  The account needs domain-wide delegation for the Gmail send scope, and `RIOSOMA_GMAIL_SENDER` has to be a mailbox in that domain.',
  },
  RIOSOMA_GMAIL_SENDER: {
    group: 'mail',
    text: 'The Google Workspace mailbox messages are sent from, as a bare address, such as `riosoma@example.com`.  The service account acts for this mailbox, which is what the delegation has to cover.',
  },
  RIOSOMA_MAIL_RELAY_URL: {
    group: 'mail',
    text: 'Where each message is posted as JSON, such as `https://relay.example.com/outbound/mail`.  It has to be an `https` address, or an `http` one on this machine for a relay running beside Riosoma.  Every post is signed, so no credentials ride in the address.  See [Email](email.md) for the post\'s shape and signature.',
  },
  RIOSOMA_MAIL_RELAY_SECRET: {
    group: 'mail',
    secret: true,
    text: 'The key each relay post is signed with, which the relay has to know too.  At least 32 random characters (`openssl rand -hex 32`) suits it.',
  },
  RIOSOMA_CLAMAV_URL: {
    group: 'files',
    text: 'Optional ClamAV daemon address, such as `tcp://clamav:3310` or `unix:///run/clamav/clamd.sock`.  This enables scanning by default when an organization has not saved its own scanner settings.  Owners and Security administrators can detect, test, and turn scanning on or off at `/settings/files#virus-scanning`.  New files stay quarantined until a complete INSTREAM scan passes.  Failed connections retry with backoff, and an hour of delay alerts administrators.  Disabling scanning never releases pending files.  Files too large to scan stay quarantined unless an administrator explicitly allows unscanned downloads.  See [File storage](file-storage.md).',
  },
  RIOSOMA_CLAMAV_APPROVED_URLS: {
    group: 'files',
    text: 'Comma-separated scanner addresses approved by the server operator.  Each uses `tcp://host:3310` or an absolute `unix:///run/clamav/clamd.sock` address.  When unset, the Compose sidecar and common sockets under `/run/clamav` and `/var/run/clamav` are approved.  A configured `RIOSOMA_CLAMAV_URL` is also approved.  Setting this list does not enable scanning.  Owners and Security administrators can detect, test, and select only approved destinations.  Removing approval blocks future file transmission to that destination, including destinations already saved in organization settings.  See [File storage](file-storage.md).',
  },
  RIOSOMA_PDF_RENDERER_URL: {
    group: 'mail',
    text: 'Optional operator-approved Gotenberg service address, such as `http://gotenberg:3000`.  PDF reports send embedded HTML, images, and theme print styles to this service.  No credentials, query, or fragment may appear in the address.  Unset uses the bundled pdfmake renderer.  History notes any simplified styling or missing characters.  Enable the Compose `pdf` profile to run an isolated sidecar.  A configured service failure follows report retries instead of silently changing renderers.',
  },
  RIOSOMA_FILES_STORAGE: {
    group: 'files',
    text: 'Where new attachments are kept: `postgres` keeps them in the database, so a database backup covers them, `local` writes them to `RIOSOMA_FILES_DIR`, `s3` to an S3-compatible bucket (AWS S3, Cloudflare R2, Backblaze B2, Google Cloud Storage, or MinIO), and `azure-blob` to an Azure Blob Storage container.  Files stored earlier are read from wherever they went until `storage:move` moves them.  At start, the server writes, reads, and deletes a small test file there, and stops if it can\'t.  See [File storage](file-storage.md).',
  },
  RIOSOMA_FILES_DIR: {
    group: 'files',
    text: 'The directory for attachments when `RIOSOMA_FILES_STORAGE` is `local`, and required then, and afterward for as long as files stored there remain.  Put it on a persistent volume that every replica shares, and back it up with the database.',
  },
  RIOSOMA_ARCHIVE_WORK_DIR: {
    group: 'files',
    text: 'Where organization exports and imports keep their working folders, which hold unencrypted organization data while a job runs.  The default is `riosoma-archives` in the system\'s temporary folder.  The server makes it if it\'s missing, lets only its own account enter it, and refuses one another account owns or a link in its place.  Servers may share it: at start, each removes only folders whose process has stopped, or that no live process can be shown to own after 24 hours.',
  },
  RIOSOMA_FILES_S3_ENDPOINT: {
    group: 'files',
    text: 'The S3-compatible service\'s address, with no bucket in it, such as `https://<account ID>.r2.cloudflarestorage.com`, `https://s3.us-west-004.backblazeb2.com`, `https://storage.googleapis.com`, or `http://minio:9000`.  Leave it out for AWS S3, whose address comes from `RIOSOMA_FILES_S3_REGION`.',
  },
  RIOSOMA_FILES_S3_REGION: {
    group: 'files',
    text: 'The region requests are signed for, such as `eu-west-1`.  AWS S3 needs the bucket\'s own.  With an endpoint and no region, Riosoma reads it from the endpoint where the service puts it there (Backblaze B2), and uses `auto` for R2 and Google Cloud Storage.',
  },
  RIOSOMA_FILES_S3_BUCKET: {
    group: 'files',
    text: 'The bucket attachments go in, which must already exist.  Required with `s3`, and afterward for as long as files stored there remain.',
  },
  RIOSOMA_FILES_S3_PREFIX: {
    group: 'files',
    text: 'A folder in the bucket that every attachment goes under, such as `riosoma/attachments`, so the bucket can hold other things too.  Leave it alone once files are stored, since they\'re found under it.',
  },
  RIOSOMA_FILES_S3_ACCESS_KEY_ID: {
    group: 'files',
    text: 'The access key ID Riosoma signs requests with.  It needs to put, get, and delete objects under the prefix, and to abort multipart uploads.',
  },
  RIOSOMA_FILES_S3_SECRET_ACCESS_KEY: {
    group: 'files',
    secret: true,
    text: 'The secret access key that goes with `RIOSOMA_FILES_S3_ACCESS_KEY_ID`.',
  },
  RIOSOMA_FILES_S3_PATH_STYLE: {
    group: 'files',
    text: 'Addresses objects as `endpoint/bucket/key` instead of `bucket.endpoint/key`.  MinIO and most self-hosted services need `true`.',
  },
  RIOSOMA_FILES_S3_SSE: {
    group: 'files',
    text: 'Server-side encryption to ask for on each object: `AES256` for keys the service manages, or `aws:kms` for AWS KMS.  Leave it out to use the bucket\'s default encryption, which is also the choice for services other than AWS S3.',
  },
  RIOSOMA_FILES_S3_KMS_KEY_ID: {
    group: 'files',
    text: 'The AWS KMS key for `aws:kms`, by key ID, ARN, or alias ARN.  Leave it out for the account\'s default key for S3.  The access key then needs `kms:GenerateDataKey` and `kms:Decrypt` on it.',
  },
  RIOSOMA_FILES_AZURE_ACCOUNT: {
    group: 'files',
    text: 'The Azure storage account\'s name.  Required with `azure-blob`, and afterward for as long as files stored there remain.',
  },
  RIOSOMA_FILES_AZURE_CONTAINER: {
    group: 'files',
    text: 'The container attachments go in, which must already exist.',
  },
  RIOSOMA_FILES_AZURE_PREFIX: {
    group: 'files',
    text: 'A folder in the container that every attachment goes under, such as `riosoma/attachments`.  Leave it alone once files are stored, since they\'re found under it.',
  },
  RIOSOMA_FILES_AZURE_ACCOUNT_KEY: {
    group: 'files',
    secret: true,
    text: 'One of the storage account\'s access keys.  Leave it out to sign in with the server\'s managed identity instead, which needs the Storage Blob Data Contributor role on the container.  Signed download addresses need the key.',
  },
  RIOSOMA_FILES_AZURE_ENDPOINT: {
    group: 'files',
    text: 'The blob service\'s address, when it isn\'t `https://<account>.blob.core.windows.net`: a sovereign cloud\'s, or Azurite\'s, such as `http://azurite:10000/devstoreaccount1`.',
  },
  RIOSOMA_FILES_AZURE_CLIENT_ID: {
    group: 'files',
    text: 'The client ID of a user-assigned managed identity to sign in with.  Leave it out for the system-assigned identity, or when using an account key.',
  },
  RIOSOMA_FILES_SIGNED_URL_SECONDS: {
    group: 'files',
    text: 'Above `0`, a download from a bucket or container is answered with a redirect to an address the store signs, which works for this many seconds, so the bytes don\'t pass through Riosoma.  The redirect comes only after Riosoma\'s own permission check, but whoever holds the address can use it until it expires, so keep it short: `300` suits most files, and long videos may need more.  The content security policy then lets pages load from the store.  At `0`, and always for `postgres` and `local`, downloads go through Riosoma.',
  },
  RIOSOMA_LIVE_TIMEOUT_MS: {
    group: 'limits',
    text: 'How long one read of a live table may run on its source, in milliseconds.  Connecting always gets at least 10 seconds, so a short limit never looks like a source that is down.',
  },
  RIOSOMA_LIVE_MAX_KEYS: {
    group: 'limits',
    text: 'The most records a view of a live table lists at once.  A view past it says the list was cut short.',
  },
  RIOSOMA_SOURCE_DUCKDB_ROOTS: {
    group: 'files',
    text: 'Comma-separated absolute directories that DuckDB file sources may read.  Empty disables local paths.  Symlinks are resolved before checking the allowlist.  Give this setting only directories intended for source data.',
  },
  RIOSOMA_SOURCE_FILE_MAX_MB: {
    group: 'files',
    text: 'The most a file source downloads for one sync or preview, in megabytes.  Downloads land in the temporary directory, so size `/tmp` to match.',
  },
  RIOSOMA_PUBLIC_FORM_HOURLY_LIMIT: {
    group: 'limits',
    text: 'Submissions one address may make to one public form in an hour.',
  },
  RIOSOMA_CUSTOM_DOMAIN_LIMIT: {
    group: 'limits',
    text: 'The most custom domains for public pages one organization may have added at once, verified or not.  Removed domains don\'t count.  Each verified domain can have the proxy request a certificate, and with on-demand TLS every certificate comes from one ACME account, so the limit keeps one organization from using up that account\'s rate limits for the others.',
  },
  RIOSOMA_SHARED_VIEW_MINUTE_LIMIT: {
    group: 'limits',
    text: 'Requests one address may make to shared view links in a minute.  Each server process counts on its own.',
  },
  RIOSOMA_SQL_POOL_MAX: {
    group: 'limits',
    text: 'Connections the SQL editor\'s queries run on, apart from the pool the rest of the app uses, so long queries never hold up other requests.  A query waits up to 15 seconds for one to come free.  Each person runs one query at a time and starts at most 30 a minute.  Each server process has its own connections and counts on its own, so the database needs room for this many more connections per process.',
  },
  RIOSOMA_SQL_OUTSIDE_LOGINS: {
    group: 'limits',
    text: 'Whether organization admins may give outside reporting tools a PostgreSQL login that reads one database as a chosen person.  The login connects to the same PostgreSQL database as everything else on the server, where PostgreSQL shows every role its catalogs and lets every role listen and send on its notification channels.  So each login can see the names of the tables and fields in every database that has a login, in every organization, and roughly how many records every table holds.  It can see the IDs of the databases and organizations that are changing, as they change, and it can send notices that make the server recheck access and browsers reload, which costs work and changes no data.  It can also run heavy queries until the server ends them.  Turn it on only when everyone who will hold a login may know and do that.  Off refuses new logins and turns off the ones that exist.  See [SQL access](sql-access.md).',
  },
  RIOSOMA_SIGNATURE_REQUEST_HOURLY_LIMIT: {
    group: 'limits',
    text: 'Signature requests one person may send in an hour, across every database.  Past it, sending another is refused with a message saying to try again later, so an editor can\'t use the server\'s mail sender to flood outside addresses.',
  },
  RIOSOMA_SIGNATURE_SIGNER_DAILY_LIMIT: {
    group: 'limits',
    text: 'Signers one person may add to signature requests in a day, counting every signer on every request they send.  Each signer gets an invitation email, so this caps the invitations one person can cause.  Past it, sending a request is refused with a message saying to try again later.',
  },
  RIOSOMA_AIRTABLE_API_SECOND_LIMIT: {
    group: 'limits',
    text: 'Requests one personal access token may make to the Airtable-compatible API, under `/v0`, in a second.  Past it, requests get a 429 answer with `Retry-After`, which Airtable\'s client libraries retry on their own.  Each server process counts on its own.',
  },
  RIOSOMA_AUTOMATIONS_ALLOW_PRIVATE_HOSTS: {
    group: 'limits',
    text: 'Lets automations, outbound webhooks, and file sources reach loopback, private, and link-local addresses.  Off, they reach only the public internet, so a workflow can\'t be pointed at the server\'s own network.',
  },
  RIOSOMA_MAP_STYLE_URL: {
    group: 'limits',
    text: 'The MapLibre style that map views draw with, as an `http` or `https` address with no credentials in it, or `off` to list places instead of drawing a map.  Browsers load the style, tiles, fonts, and sprites from that host, and the content security policy allows it.',
  },
  RIOSOMA_GITHUB_API_URL: {
    group: 'limits',
    text: 'The GitHub API that bug reports from feedback go to, when an admin connects a repository.  Set it to a GitHub Enterprise Server\'s API address to use one.',
  },
  RIOSOMA_HUB_URL: {
    group: 'limits',
    text: 'Bug relay base address, defaulting to https://hub.riosoma.com.  Set `off` to prevent upstream reports, or use another hub.  Each organization starts with relay off.  An admin reviews and confirms each software bug before sending it.  Compose operators can set it in `.env`.  Screenshots never go upstream.',
  },
  RIOSOMA_DROPBOX_APP_KEY: {
    group: 'drives',
    text: 'The app key of the Dropbox app people connect to add attachments from Dropbox.  With it and `RIOSOMA_DROPBOX_APP_SECRET` set, admin settings show the app as set by the server and can only turn it off.  Unset, an admin can enter the app under Integrations instead.  [Cloud drives](cloud-drives.md) explains how to register the app.',
  },
  RIOSOMA_DROPBOX_APP_SECRET: {
    group: 'drives',
    secret: true,
    text: 'The app secret of the Dropbox app named by `RIOSOMA_DROPBOX_APP_KEY`.',
  },
  RIOSOMA_XERO_CLIENT_ID: {
    group: 'drives',
    text: 'The client ID of the Xero OAuth app people connect to sync accounting sources.  Server settings take precedence over credentials entered under Settings, Integrations.  Register the callback address shown there.  [Connected accounts](cloud-drives.md) explains setup and permissions.',
  },
  RIOSOMA_XERO_CLIENT_SECRET: {
    group: 'drives',
    secret: true,
    text: 'The client secret of the Xero OAuth app people connect to sync accounting sources.  Server settings take precedence over credentials entered under Settings, Integrations.  Register the callback address shown there.  [Connected accounts](cloud-drives.md) explains setup and permissions.',
  },
  RIOSOMA_QUICKBOOKS_CLIENT_ID: {
    group: 'drives',
    text: 'The client ID of the QuickBooks Online OAuth app people connect to sync accounting sources.  Server settings take precedence over credentials entered under Settings, Integrations.  Register the callback address shown there.  [Connected accounts](cloud-drives.md) explains setup and permissions.',
  },
  RIOSOMA_QUICKBOOKS_CLIENT_SECRET: {
    group: 'drives',
    secret: true,
    text: 'The client secret of the QuickBooks Online OAuth app people connect to sync accounting sources.  Server settings take precedence over credentials entered under Settings, Integrations.  Register the callback address shown there.  [Connected accounts](cloud-drives.md) explains setup and permissions.',
  },
  RIOSOMA_GITHUB_OAUTH_CLIENT_ID: {
    group: 'drives',
    text: 'The client ID of the GitHub OAuth app people connect to sync app sources.  With it and `RIOSOMA_GITHUB_OAUTH_CLIENT_SECRET` set, server settings take precedence, and admins can only turn the provider off.  Unset, an admin can register the app under Settings, Integrations.  Use the callback address shown there.  [Connected accounts](cloud-drives.md#github-app-sources) explains setup and permissions.',
  },
  RIOSOMA_GITHUB_OAUTH_CLIENT_SECRET: {
    group: 'drives',
    secret: true,
    text: 'The client secret of the GitHub OAuth app named by `RIOSOMA_GITHUB_OAUTH_CLIENT_ID`.',
  },
  RIOSOMA_BOX_CLIENT_ID: {
    group: 'drives',
    text: 'The client ID of the Box app people connect to add attachments from Box.  With it and `RIOSOMA_BOX_CLIENT_SECRET` set, admin settings show the app as set by the server and can only turn it off.  Unset, an admin can enter the app under Integrations instead.',
  },
  RIOSOMA_BOX_CLIENT_SECRET: {
    group: 'drives',
    secret: true,
    text: 'The client secret of the Box app named by `RIOSOMA_BOX_CLIENT_ID`.',
  },
  RIOSOMA_GOOGLE_OAUTH_CLIENT_ID: {
    group: 'drives',
    text: 'The OAuth client ID people connect to add attachments from Google Drive, which asks only for the files each person picks.  Google Drive needs this, `RIOSOMA_GOOGLE_OAUTH_CLIENT_SECRET`, and `RIOSOMA_GOOGLE_PICKER_API_KEY`.  While all three are set and an admin hasn\'t turned Google Drive off, the content security policy lets the app load Google\'s Picker.',
  },
  RIOSOMA_GOOGLE_OAUTH_CLIENT_SECRET: {
    group: 'drives',
    secret: true,
    text: 'The client secret of the OAuth client named by `RIOSOMA_GOOGLE_OAUTH_CLIENT_ID`.',
  },
  RIOSOMA_GOOGLE_PICKER_API_KEY: {
    group: 'drives',
    text: 'The API key Google\'s Picker opens with.  Every browser that opens the Picker receives it, so restrict it to the Picker API and to this server\'s address in Google Cloud.',
  },
  RIOSOMA_MICROSOFT_TEAMS_TENANT_ID: {
    group: 'notifications',
    text: 'The directory tenant ID for the Microsoft Entra app that sends Teams direct-message notifications.  Set it with `RIOSOMA_MICROSOFT_TEAMS_CLIENT_ID` and `RIOSOMA_MICROSOFT_TEAMS_CLIENT_SECRET` to configure the app on the server.  An administrator can also enter the app under Settings, Integrations, which shows the Web redirect address to register.  See [Teams direct messages](microsoft-365.md#direct-message-notifications).',
  },
  RIOSOMA_MICROSOFT_TEAMS_CLIENT_ID: {
    group: 'notifications',
    text: 'The application client ID for the Teams direct-message app named by `RIOSOMA_MICROSOFT_TEAMS_TENANT_ID`.',
  },
  RIOSOMA_MICROSOFT_TEAMS_CLIENT_SECRET: {
    group: 'notifications',
    secret: true,
    text: 'The client secret for the Teams direct-message app named by `RIOSOMA_MICROSOFT_TEAMS_CLIENT_ID`.',
  },
  RIOSOMA_UPDATE_CHECKS: {
    group: 'updates',
    text: '`off` stops update checks entirely, for servers with no way out to the internet.  At `on`, the server fetches `RIOSOMA_UPDATE_FEED_URL` once a day and whenever an admin asks, and the owner and admins see a notice when a newer release is out.  A check sends nothing about the server: it downloads the feed and compares versions itself.  See [Updates](updater.md).',
  },
  RIOSOMA_UPDATE_FEED_URL: {
    group: 'updates',
    text: 'The signed feed of releases.  The server only believes a feed signed with a key its release carries, signed within the last 14 days, and no older than the last one it verified, so a copy of the feed on another address works as well as the original.  Leave it at the default unless you mirror the feed.',
  },
  RIOSOMA_UPDATE_FEED_KEYS_FILE: {
    group: 'updates',
    compose: false,
    text: 'For testing only.  A JSON file of the keys a feed may be signed with, as a list of `{ "id", "publicKey" }` in the format of `deploy/updater/feed-keys.json`, used in place of the keys this release carries, so a test can sign its own feed.  A file that can\'t be read or holds anything else stops the server.  Never set it on a server people use, since whoever holds a key it names can offer that server any image.  The updater\'s `UPDATER_FEED_KEYS_FILE` does the same for the updater.  See [Updates](updater.md#testing-with-your-own-feed).',
  },
  RIOSOMA_TELEMETRY: {
    group: 'updates',
    text: '`off` keeps anonymous usage counts off whatever the owner chose, and the owner sees that the server decided.  At `on`, the counts still stay off until the owner turns them on, during setup or in Settings.',
  },
  RIOSOMA_TELEMETRY_URL: {
    group: 'updates',
    text: 'Where the weekly usage counts go, once the owner turns them on.  The owner\'s settings show this address, exactly what would be sent, and the last payload sent.',
  },
  RIOSOMA_UPDATER_URL: {
    group: 'updates',
    text: 'The updater sidecar\'s address on the internal Compose network it shares with Riosoma alone.  The Compose file sets `http://updater:8090`.  With `RIOSOMA_UPDATER_TOKEN` set too, and the `updater` and `backup` profiles on, the owner can update with one click.  See [Updates](updater.md).',
  },
  RIOSOMA_UPDATER_TOKEN: {
    group: 'updates',
    secret: true,
    text: 'The secret the server and the updater sidecar share: 32 to 512 letters, digits, underscores, or hyphens, such as `openssl rand -hex 32` makes.  Unset, the server doesn\'t use the updater, and the notice shows the steps to update by hand.',
  },
  RIOSOMA_INSTALL_METHOD: {
    group: 'updates',
    text: 'How this server was installed, which decides the update steps the notice shows.  The Compose file sets `compose` and the Helm chart `helm`.  At `auto`, the server recognizes Kubernetes, Container Apps, ECS, Cloud Run, and plain Docker from the variables each platform sets, and otherwise takes it that it runs from source.',
  },
  RIOSOMA_DRIVERS_DIR: {
    group: 'image',
    text: 'Persistent storage for admin-installed source drivers.  Defaults to the drivers folder inside `RIOSOMA_CONFIG_DIR`.  Mount the same storage on every server and worker, and include it in backups.  Only the server installs drivers.',
  },
  RIOSOMA_DRIVER_INSTALLS: {
    group: 'image',
    text: 'Whether Data Sources administrators may install or update catalog drivers after accepting their licenses.  Off blocks both downloads and uploads.  Existing drivers remain usable and may be removed.',
  },
  RIOSOMA_CONNECTOR_SERVICE_URL: {
    group: 'limits',
    text: 'Where the connector service answers, which runs the MySQL, SQL Server, Oracle, Firebird, Snowflake, BigQuery, Databricks, ClickHouse, and MongoDB sources.  The Compose file sets `http://connector-service:8091` and the Helm chart its own Service.  Unset, a server run from source starts the service itself on a port of this machine, and a container looks for it at `http://127.0.0.1:8091`, as a sidecar would answer.  Without it, only those sources stop working, and `/healthz` reports it.',
  },
  RIOSOMA_CONNECTOR_SERVICE_TOKEN: {
    group: 'limits',
    secret: true,
    text: 'The token the server and the connector service share, of 32 through 512 letters, digits, underscores, or hyphens.  Optional: unset, the server generates one on its first start into `RIOSOMA_CONNECTOR_SERVICE_TOKEN_FILE`, where the Compose file\'s connector service reads it, and the Helm chart generates its own.  Set the same value on both when they share no storage, as with a sidecar.',
  },
  RIOSOMA_CONNECTOR_SERVICE_TOKEN_FILE: {
    group: 'limits',
    text: 'Where the generated connector service token is kept.  Defaults to `connector-service.token` inside `RIOSOMA_CONFIG_DIR`.  The Compose file sets `/connector-token/token`, on storage the connector service mounts read-only.  The connector service reads the same setting.',
  },
  RIOSOMA_WEB_DIR: {
    group: 'image',
    compose: false,
    text: 'The built web app.  The image sets `/app/web`.  Running from source, the server finds `apps/web/dist` on its own.',
  },
  RIOSOMA_THEMES_DIR: {
    group: 'image',
    compose: false,
    text: 'The theme stylesheets and assets.  The image sets `/app/themes`.  Running from source, the server finds `themes/` on its own.',
  },
};

/** Reads the environment schema: each setting's base type, modifiers, and default. */
function readSchema() {
  const path = join(ROOT, CONFIG);
  const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
  const constants = new Map();
  let schema = null;
  source.forEachChild((node) => {
    if (!ts.isVariableStatement(node)) return;
    for (const declaration of node.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
      const name = declaration.name.text;
      if (ts.isStringLiteral(declaration.initializer)) constants.set(name, declaration.initializer.text);
      if (name === 'EnvSchema') schema = declaration.initializer;
    }
  });
  if (!schema || !ts.isCallExpression(schema) || !ts.isObjectLiteralExpression(schema.arguments[0])) {
    throw new Error(`${CONFIG}: EnvSchema = z.object({...}) not found`);
  }
  const literal = (node) => {
    if (ts.isNumericLiteral(node)) return Number(node.getText(source).replaceAll('_', ''));
    if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken) {
      return -literal(node.operand);
    }
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (ts.isIdentifier(node) && constants.has(node.text)) return constants.get(node.text);
    throw new Error(`${CONFIG}: can't read the value ${node.getText(source)}`);
  };

  const settings = [];
  for (const property of schema.arguments[0].properties) {
    if (!ts.isPropertyAssignment(property)) throw new Error(`${CONFIG}: unexpected schema entry`);
    const name = property.name.getText(source);
    const calls = [];
    let node = property.initializer;
    while (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      calls.unshift({ method: node.expression.name.text, args: node.arguments });
      node = node.expression.expression;
    }
    const base = `${node.getText(source)}.${calls[0]?.method}`;
    const setting = { name, kind: null, values: null, integer: false, min: null, max: null };
    setting.hasDefault = false;
    setting.checked = false;
    if (base === 'z.coerce.number') setting.kind = 'number';
    else if (base === 'z.string') setting.kind = 'text';
    else if (base === 'z.enum') {
      setting.kind = 'enum';
      setting.values = calls[0].args[0].elements.map(literal);
    } else throw new Error(`${CONFIG}: ${name} has a type this tool doesn't know (${base})`);
    for (const { method, args } of calls.slice(1)) {
      if (method === 'int') setting.integer = true;
      else if (method === 'positive') setting.min = setting.integer ? 1 : 0;
      else if (method === 'nonnegative') setting.min = 0;
      else if (method === 'min') setting.min = literal(args[0]);
      else if (method === 'max') setting.max = literal(args[0]);
      else if (method === 'url') setting.kind = 'url';
      else if (method === 'email') setting.kind = 'email';
      else if (method === 'refine' || method === 'regex') setting.checked = true;
      else if (method === 'default') {
        setting.hasDefault = true;
        setting.default = literal(args[0]);
      } else if (method === 'catch') {
        setting.fallback = literal(args[0]);
      } else if (method === 'transform') {
        const clamp = /^\(value\) => Math\.min\(Math\.floor\(value\), (\d+)\)$/.exec(args[0].getText(source));
        if (!clamp) throw new Error(`${CONFIG}: unsupported transform for ${name}`);
        setting.max = Number(clamp[1]);
      } else if (method !== 'optional' && method !== 'trim') {
        throw new Error(`${CONFIG}: ${name} uses .${method}(), which this tool doesn't describe`);
      }
    }
    // `positive` read before `int` still means at least 1 for a whole number.
    if (setting.integer && setting.min === 0 && calls.some((c) => c.method === 'positive')) setting.min = 1;
    settings.push(setting);
  }
  return settings;
}

const code = (value) => `\`${value}\``;
const number = (value) => value.toLocaleString('en-US');

function accepts(setting) {
  if (setting.kind === 'enum') {
    const values = setting.values.map(code);
    return values.length === 2 ? `${values[0]} or ${values[1]}` : `${values.slice(0, -1).join(', ')}, or ${values.at(-1)}`;
  }
  if (setting.kind === 'number') {
    if (setting.fallback !== undefined) return `Number, rounded down and capped at ${number(setting.max)}.  Invalid or below ${number(setting.min)} uses ${number(setting.fallback)}`;
    const noun = setting.integer ? 'Whole number' : 'Number';
    if (setting.min !== null && setting.max !== null) return `${noun}, ${number(setting.min)} to ${number(setting.max)}`;
    if (setting.min !== null) return `${noun}, ${number(setting.min)} or more`;
    return noun;
  }
  if (setting.kind === 'url') return 'URL';
  if (setting.kind === 'email') return 'Email address';
  if (setting.min > 1) return `Text, ${setting.min} characters or more`;
  return 'Text';
}

function defaultValue(setting) {
  if (!setting.hasDefault) return 'Unset';
  if (setting.default === '') return 'Empty';
  return code(setting.default);
}

const cell = (text) => text.replaceAll('|', '\\|');

function render(settings) {
  const lines = [
    '# Settings reference',
    '',
    '<!-- Generated by tools/settings_reference.mjs from apps/server/src/config.ts.  Edit the descriptions in that script, then run: pnpm settings:docs -->',
    '',
    'Riosoma reads these environment variables when it starts.  They win over `riosoma.config.json`, the file the setup wizard writes in the config directory.  Unless a setting documents a fallback, an invalid value stops the server with a JSON line naming the setting, never the value.',
    '',
    'An empty or whitespace-only `RIOSOMA_*` value is treated as unset, so its default or stored value applies.  Nonempty values still follow their validation rules.  Kubernetes service-link variables are ignored with one warning per variable naming it and explaining why.',
    '',
    '**Nothing is strictly required.**  With no database, the server starts in setup mode and asks for one in the browser.  Wherever the container\'s file system doesn\'t last, such as Cloud Run, Container Apps, and ECS on Fargate, or with more than one replica, set all three of these so a restart loses nothing:',
    '',
    '- `RIOSOMA_DATABASE_URL` or `RIOSOMA_DATABASE_PROFILE`',
    '- `RIOSOMA_SECRET_KEY`',
    '- `RIOSOMA_BASE_URL`',
    '',
    'Settings marked secret belong in the platform\'s secret store, not in plain configuration.',
    '',
    '## Build languages',
    '',
    'Public releases v0.95 and v1 ship in American English only.  `RIOSOMA_LOCALES` is a build-time setting for the web app, separate from server settings.  It defaults to `en-US`.  Set a comma-separated list, such as `RIOSOMA_LOCALES=en-US,fr`, before building to offer exactly those languages.  The list must include `en-US` for fallback.  Unknown languages and pseudo-locales are rejected in production.  Changing it requires rebuilding the web app or image.',
    '',
    'For a Docker image, run `docker build --build-arg RIOSOMA_LOCALES=en-US,fr -t riosoma .` to compile English and French into the image.',
    '',
    'When only English is enabled, language settings and pickers are hidden, browser languages and unsupported saved or `?lang=` preferences resolve to `en-US`, and only English message catalogs and help modules are bundled.  Narration and demo media use English.  PDF report fonts remain available for multilingual report content.  Rio can still answer in the language a person writes.  Its fixed interface text follows the build languages.',
    '',
    'Development and test builds keep every language and the pseudo-locales regardless of this setting.  After `pnpm turbo run build`, run `pnpm --filter @riosoma/e2e e2e`.  The browser suite builds and serves a separate all-language test artifact, checks its catalogs before starting, and removes it after the run.  Release output stays in `apps/web/dist`.  Release CI checks only enabled languages with `node tools/i18n_check.mjs --enabled`.  Run the checker without `--enabled` for a full translation check.',
    '',
  ];
  for (const [group, title] of GROUPS) {
    const order = Object.keys(DETAILS);
    const members = settings
      .filter((s) => DETAILS[s.name].group === group)
      .sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
    if (!members.length) continue;
    lines.push(`## ${title}`, '');
    lines.push('| Setting | Default | Accepts | Secret |', '|---|---|---|---|');
    for (const s of members) {
      lines.push(`| ${code(s.name)} | ${cell(defaultValue(s))} | ${cell(accepts(s))} | ${DETAILS[s.name].secret ? 'Yes' : ''} |`);
    }
    lines.push('');
    for (const s of members) lines.push(`**${code(s.name)}.**  ${DETAILS[s.name].text}`, '');
  }
  lines.push(
    '## Public sharing',
    '',
    'Organization owners and security administrators manage public sharing at `/settings/public-sharing`.  External embedding is allowed by the organization by default, but each public view, form, and booking page starts with embedding off.  Owners can list up to 20 exact HTTP or HTTPS origins per page.  Wildcards, paths, queries, and credentials are refused.  All other pages keep same-origin framing.',
    '',
    'Public file links default to off.  When enabled, signed links name one file and expire after 3,600 seconds by default.  The lifetime accepts 60 through 604,800 seconds.  Disabling public files revokes existing links immediately.  Files on public views must remain visible through the shared field and record, and forms publish only supporting files selected by their owner.  Quarantined files are never served.  These controls are stored in the database and add no environment variables.  Organization imports do not restore this security policy.',
    '',
    '## OAuth apps',
    '',
    'OAuth app settings are stored per organization under OAuth apps in settings.  Owners and administrators with the Integrations role manage them.  Dynamic registration for MCP clients defaults to off.  When enabled for exactly one organization, the public registration endpoint creates unverified public clients limited to MCP scopes.  Turning it off blocks registration and new authorization for those clients, while existing grants remain until revoked.  Each network address may register 5 clients a day, and a registration expires when it goes unused for 7 days or idle for 90.  The configured base URL supplies the issuer and resource identifiers, and OAuth stays off unless it uses HTTPS or a loopback address.  See [reviewing OAuth apps](../modules/administration/oauth-apps/en-US.md).',
    '',
    '## Incoming file originals',
    '',
    'Organization owners and Security administrators manage incoming file settings through `GET /api/org/ingest` and `POST /api/org/ingest/commands`.  The `organization.ingest` command accepts `settings.originalKeepDays` and `settings.probationFiles`.  Originals default to 90 days.  Retention accepts 30, 90, 180, or 365 days, any whole number from 1 through 3,650, or `"forever"`.  Tables start with `originals.keepDays` set to `null`, following the organization.  Examples remain exempt while they are examples.  Probation defaults to 3 clean files and accepts whole numbers from 1 through 10.',
    '',
    'People with schema rights use `POST /api/tables/:tableId/ingest/originals/commands` to set `ingest.originals.readOnly`, `ingest.originals.share`, or `ingest.originals.retention`.  Retention periods count from each file’s arrival.  Shortening that deletes originals returns `confirmation-required`, the original count, byte count, exempt example count, and a `confirmationToken`.  Send the same command again with that token to apply it.  Tokens expire after ten minutes and require a fresh preview if the originals or settings change.  Lengthening never restores deleted originals.  Legal holds prevent deletion.',
    '',
    'Editors open an original through `GET /api/tables/:tableId/ingest/files/:fileId/original`.  Readers, commenters, and editors with record or field restrictions require the table’s read-only switch.  Bearer tokens also require `data.records:read`.  Shared views and public links use `/api/public/views/:linkId/ingest/files/:fileId/original`.  Published interfaces and sites use `/api/public/sites/:slug/tables/:tableId/ingest/files/:fileId/original`.  Each publication has its own switch, initially off, independent of the table’s switch.  Published interfaces and sites share the switch on their publication row.  Passwords, current publication access, file scanning, and public-file policy still apply.  Refusals answer not found.  Authorized people receive a typed `expired` outcome with HTTP 410 after expiry.  Opens and refusals are audited by file ID.',
    '',
    'An hourly job removes expired originals in batches of at most 100.  It preserves ingested rows and file activity, records expiry on the activity entry, and clears the stored original reference.  Database deletion commits before outside bytes are deleted.  Failed outside deletions remain queued and retry hourly.  Cleanup queues never travel in organization archives, and restored shares start with original access off.',
    '',
    '## SQL access',
    '',
    'SQL settings are stored per database under SQL administration, rather than in environment variables.  Roles allowed to use the editor default to owner only.  Query timeout defaults to 15,000 milliseconds and accepts 10 through 120,000.  Maximum result rows defaults to 10,000 and accepts 1 through 100,000.  Outside login settings choose whether access is enabled and which active person it reads as.  Organization owners and security administrators manage these settings.  Editor queries run on connections of their own, set with `RIOSOMA_SQL_POOL_MAX`.  See [SQL access](sql-access.md) for automatic and database-administrator setup.',
    '',
    '## Payments',
    '',
    'Payments are stored per organization and page in the database.  They add no server environment settings.  Integrations administrators connect a Stripe secret key and webhook signing secret under Integrations.  Both are encrypted, never returned by the API, and retained for existing payments after disconnection.  The key is checked through a read-only balance request.  The connection reports test or live mode and its webhook address.  A configured public base URL is required.',
    '',
    '| Setting | Default | Description |',
    '|---|---|---|',
    '| Require payment | Off | Adds protected payment status, amount paid, and payment reference fields to the table.  Turning it off keeps existing results. |',
    '| Currency | USD in the editor | One supported currency per page.  Japanese yen and South Korean won use whole units.  Each price has to reach the minimum for its currency: the minimum Stripe publishes, raised where needed to convert to at least 50 US cents.  Lower prices are refused when the page is saved. |',
    '| Price | Fixed, with no amount | A positive decimal price in ordinary currency units, or a price for every option of one single select question.  The server calculates the charge. |',
    '| Quantity field | None | An optional number question whose submitted value must be a whole number from 1 through 10,000.  Without it, quantity is one. |',
    '| Checkout expiry | 30 minutes | A pending booking holds its place until Stripe says its Checkout Session expired or was paid, or an hour after the session closed if that word never comes.  Trashing its record frees the place at once and ends the session at Stripe, and a payment that arrives anyway is refunded.  One network address, or IPv6 /64, holds one place per page at a time, and pending bookings take at most a third of the places in a day. |',
    '',
    'See [Taking payments](../modules/databases/payments/en-US.md) for webhook events, key permissions, and refunds.',
    '',
    '## Organization provisioning',
    '',
    'Security administrators manage these settings in Settings → Provisioning.  They are stored per organization in the database, rather than in environment variables.',
    '',
    '| Setting | Default | Description |',
    '|---|---|---|',
    '| `dryRun` | `false` | Validate provisioning requests and audit their proposed changes without saving people, groups, or membership changes.  Token usage and audit records are still saved.  Previewed resources cannot be read by later requests. |',
    '| `deleteAction` | `suspend` | `suspend` ends sessions and API tokens while preserving data and ownership.  `remove` deletes the person and their access, after giving each database only they owned to the organization\'s owner.  Either way, the provisioning tokens the person created stop working.  Setting `active` to `false` always suspends, regardless of this setting. |',
    '| Token name | Required on creation | Identifies the provisioning connection in the audit log.  The token is shown once, stored as a hash, limited to its organization, and limited to 120 requests per minute.  Rotation immediately revokes the previous token. |',
    '| Single sign-on domain | Unverified | A DNS TXT challenge verifies each allowed email domain for a single sign-on connection.  The challenge expires after one day.  Only one organization on the server can verify a domain.  Verified domains are checked daily, and three failed checks in a row take verification away and notify the owner and Security administrators.  Provisioned people cannot link their first sign-in by email until the domain is verified. |',
    '',
    'See [SCIM provisioning](../modules/administration/scim-provisioning/en-US.md) for provider setup and attribute mappings.',
    '',
  );
  return `${lines.join('\n').trimEnd()}\n`;
}

function filesUnder(dir) {
  const full = join(ROOT, dir);
  const found = [];
  const walk = (path) => {
    for (const entry of readdirSync(path)) {
      const next = join(path, entry);
      if (statSync(next).isDirectory()) walk(next);
      else found.push(next);
    }
  };
  try {
    walk(full);
  } catch {
    return [];
  }
  return found;
}

/** Problems with the install files: unknown setting names, and settings Compose doesn't pass. */
function driftProblems(settings) {
  const known = new Set(settings.map((s) => s.name));
  const compose = readFileSync(join(ROOT, COMPOSE), 'utf8');
  // Compose's own variables (the image and the published address) are interpolated, never passed,
  // and the Dockerfile's build arguments are set when the image is built.
  const dockerfile = readFileSync(join(ROOT, 'Dockerfile'), 'utf8');
  const otherNames = new Set([
    // Selects web and clipper build languages.  It is never a server runtime setting.
    'RIOSOMA_LOCALES',
    // Enables the optional live scanner tests, without changing server runtime configuration.
    'RIOSOMA_TEST_CLAMAV_URL',
    // Supplies optional live vault test identities without changing server runtime configuration
    'RIOSOMA_CREDENTIAL_TEST_PROFILES',
    // The release signing utility reads this privately; the server and hub never receive it.
    'RIOSOMA_FEED_SIGNING_KEY',
    // Where the connector service listens.  Only the service reads them, never the server.
    'RIOSOMA_CONNECTOR_SERVICE_HOST',
    'RIOSOMA_CONNECTOR_SERVICE_PORT',
    ...[...compose.matchAll(/\$\{(RIOSOMA_[A-Z0-9_]+)/g)].map((m) => m[1]),
    ...[...dockerfile.matchAll(/^ARG (RIOSOMA_[A-Z0-9_]+)/gm)].map((m) => m[1]),
  ]);
  const problems = [];
  for (const file of SCANNED.flatMap(filesUnder)) {
    const text = readFileSync(file, 'utf8');
    for (const [name] of text.matchAll(/\bRIOSOMA_[A-Z0-9_]*[A-Z0-9]\b/g)) {
      if (!known.has(name) && !otherNames.has(name)) {
        problems.push(`${relative(ROOT, file)} names ${name}, which isn't a setting in ${CONFIG}`);
      }
    }
  }
  const passed = new Set([...compose.matchAll(/^ {6}(RIOSOMA_[A-Z0-9_]+):/gm)].map((m) => m[1]));
  for (const s of settings) {
    if (DETAILS[s.name].compose === false || passed.has(s.name)) continue;
    problems.push(`${COMPOSE} doesn't pass ${s.name} to the riosoma service`);
  }
  return [...new Set(problems)];
}

const settings = readSchema();
const names = new Set(settings.map((s) => s.name));
const problems = [];
for (const s of settings) if (!DETAILS[s.name]) problems.push(`${s.name} has no description in this script`);
for (const name of Object.keys(DETAILS)) {
  if (!names.has(name)) problems.push(`${name} is described here but isn't in ${CONFIG}`);
}
for (const [name, detail] of Object.entries(DETAILS)) {
  if (!GROUPS.some(([group]) => group === detail.group)) problems.push(`${name} has an unknown group`);
}
if (problems.length) {
  for (const problem of problems) console.error(problem);
  process.exit(1);
}

const page = render(settings);
const target = join(ROOT, OUTPUT);
if (process.argv.includes('--check')) {
  let current = '';
  try {
    current = readFileSync(target, 'utf8');
  } catch {
    // Reported below as stale.
  }
  if (current !== page) problems.push(`${OUTPUT} is stale: run pnpm settings:docs`);
  problems.push(...driftProblems(settings));
  if (problems.length) {
    for (const problem of problems) console.error(problem);
    process.exit(1);
  }
  console.log(`${OUTPUT} is current, and the install files name only real settings.`);
} else {
  writeFileSync(target, page);
  console.log(`Wrote ${OUTPUT} (${settings.length} settings).`);
}
