# Dependency advisory review

The [dependency guide](dependencies.md) explains which advisories block a build, the deadlines for the rest, and the rules for new dependencies.  This file records the reviews of specific advisories.

Reviewed on October 31, 2026, using [osv-scanner v2.6.0](https://github.com/google/osv-scanner/releases/tag/v2.6.0), with its Linux x86-64 binary verified against the release's `osv-scanner_SHA256SUMS` (SHA-256 `ca69b3d3cd08f889a49dc0a383122f71cc528b83803671df5fd874d97485b108`).

```sh
export PATH="$PWD/.ci-tools:$PATH"
osv-scanner scan source --lockfile pnpm-lock.yaml --lockfile integrations/zapier/pnpm-lock.yaml \
  --lockfile apps/hub/pnpm-lock.yaml --lockfile integrations/n8n/pnpm-lock.yaml
```

Since November 14, 2026, the hub (`apps/hub`) and the n8n node (`integrations/n8n`) keep their own lockfiles outside the workspace, as the Zapier app does, so the scan names four lockfiles.  osv-scanner reads the `osv-scanner.toml` beside each lockfile it scans, not only the root one.  The zod exception below therefore lives in `integrations/n8n/osv-scanner.toml`, and `tools/ci/check_advisory_ignores.py` checks both files.  Each new lockfile has its own weekly Dependabot entry.  Entries below dated before the split describe the two-lockfile scan of that time.

## Newly published advisories (October 31, 2026)

Downloaded the Linux x86-64 v2.6.0 binary and the release's `osv-scanner_SHA256SUMS` into git-excluded `.ci-tools/`.  The matching `sha256sum -c` check passed with the SHA-256 above.  The exact two-lockfile command above loaded the root config, exited 1, and reproduced all six findings: follow-redirects 1.16.1, glob 11.1.0/13.0.6, and minimatch 3.1.5/5.1.9/10.2.6.  Zapier had no findings.

Read the three [OSV records](https://api.osv.dev/v1/vulns/GHSA-mrwp-f3q8-3g9p) ([glob](https://api.osv.dev/v1/vulns/GHSA-3g3m-2fjr-6pw4), [minimatch](https://api.osv.dev/v1/vulns/GHSA-g3hv-75wg-m249)) and checked published npm releases before choosing overrides.  These records were published late on October 30 UTC, after the previous review; the unchanged lockfile therefore began failing against the updated advisory database.

| Advisory | Affected range and vulnerable function | Fix availability |
| --- | --- | --- |
| [GHSA-mrwp-f3q8-3g9p](https://osv.dev/GHSA-mrwp-f3q8-3g9p) | `>=1.16.0 <1.16.2`; `index.js` validates `sensitiveHeaders` with the realm-dependent `isArray()` helper (`instanceof Array`), allowing custom credential headers through cross-origin redirects when the array comes from another realm | 1.16.2 fixes the installed 1.x line |
| [GHSA-3g3m-2fjr-6pw4](https://osv.dev/GHSA-3g3m-2fjr-6pw4) | `>=9.0.0 <14.0.2`; `GlobUtil.walkCB`, `walkCB2`, `walkCBSync`, and `walkCB2Sync` in `src/walker.ts` continue traversing after an aborted signal because their cancellation branches call `cb()` without returning | 14.0.2 fixes it; no 11.x or 13.x backports (latest 11.1.0 and 13.0.6) |
| [GHSA-g3hv-75wg-m249](https://osv.dev/GHSA-g3hv-75wg-m249) | OSV declares `<11.0.1`, including all three installed lines; `firstPhasePreProcess()` amplifies glob parts with `optimizationLevel >= 2`, followed by quadratic comparisons in `secondPhasePreProcess()` | 11.0.1 fixes it; no 3.x, 5.x, or 10.x backports (latest 3.1.5, 5.1.9, and 10.2.6) |

`npx --yes pnpm@11.22.0 -r why follow-redirects glob minimatch --json` traced the original versions:

| Version | Consumers and exposure |
| --- | --- |
| follow-redirects 1.16.1 | Axios 1.20.0 through connectors → Snowflake SDK 3.3.0 (server runtime), and n8n-workflow 2.40.1 (integration development dependency, also via its lint plugin) |
| glob 11.1.0 | Web development dependency vite-plugin-pwa 1.3.0 → workbox-build 7.4.1 |
| glob 13.0.6 | Server → @fastify/static 10.1.5 (runtime) |
| minimatch 3.1.5 | Server → ExcelJS 4.4.0 → archiver 5.3.2 → archiver-utils 2.1.0 → glob 7.2.3; also archiver → zip-stream 4.1.1 → archiver-utils 3.0.4 → glob 7; and ExcelJS → unzipper 0.10.14 → fstream 1.0.12 → rimraf 2.7.1 → glob 7 (all runtime) |
| minimatch 5.1.9 | ExcelJS → archiver → readdir-glob 1.1.3 (runtime); and Workbox → @trickfilm400/rollup-plugin-off-main-thread → EJS 3.1.10 → Jake 10.9.4 → filelist 1.0.6 (build only) |
| minimatch 10.2.6 | glob 11/13 above; ESLint 10.11.0 directly and through @eslint/config-array 0.23.5; @typescript-eslint/typescript-estree 8.70.0/8.70.1 through root TypeScript ESLint and n8n lint tooling |

[Current consumer metadata](https://registry.npmjs.org/workbox-build) still requests vulnerable versions: Workbox 7.4.1 uses glob 11, [Fastify static 10.1.8](https://registry.npmjs.org/@fastify%2fstatic/10.1.8) uses glob 13, [ESLint 10.14.0](https://registry.npmjs.org/eslint/10.14.0) and [typescript-estree 8.72.1](https://registry.npmjs.org/@typescript-eslint%2ftypescript-estree/8.72.1) use minimatch 10.  [Filelist 2.0.2](https://registry.npmjs.org/filelist/2.0.2) and [readdir-glob 3.0.0](https://registry.npmjs.org/readdir-glob/3.0.0) also still use minimatch 10.  Updating them alone cannot resolve these findings.  [ExcelJS 4.4.0](https://registry.npmjs.org/exceljs/4.4.0) is still current and retains its older archive dependencies.

The workspace overrides apply these fixes, with no new exceptions:

- follow-redirects 1.16.2, a same-major patch for both Axios paths.
- ExcelJS's unzipper moves to 0.12.5, removing the runtime fstream → rimraf 2 → glob 7 callback path.  Its streaming reader still calls `unzipper.Parse({forceStream: true})` and consumes entries asynchronously; the new streaming workbook regression exercises this API.
- glob 14.0.2 replaces 7.2.3, 11.1.0, and 13.0.6.  Archiver-utils 2.1.0/3.0.4 use only `glob.sync()`; Workbox uses `globSync()`; Fastify static awaits `glob()`.  These APIs and their used options (`cwd`, `follow`, `nodir`, `dot`, `ignore`, and `absolute`) remain supported.  The unzipper update removes the only consumer requiring glob 7's callback interface, so no callback consumer is forced onto the Promise API.  Node 24 satisfies the new packages' engines.
- minimatch 11.0.1 for all remaining consumers.  Readdir-glob uses the retained `Minimatch` class and `.match()`; filelist uses the retained CommonJS object's `.match(files, pattern, options)` export.  The glob and lint consumers already use named exports.  No remaining consumer calls the old CommonJS module as a function.

A direct minimatch 3 → 11 override with glob 7 was rejected by a real traversal check: glob 7 reads the private regexp property `_glob`, which minimatch 11 removed.  Retaining the `Minimatch` constructor alone would not prove compatibility.  Replacing glob itself removes that dependency on private internals.  Newer archive consumers were checked first: archiver-utils 5 changes stream normalization to return `source.pipe(...)`, but ExcelJS's custom StreamBuf returns a Promise from `pipe`, breaking even Archiver 7's streaming ZIP writer.  Archiver 8 also replaces the callable CommonJS factory with ESM named classes.  Keep the original Archiver 5/archive utilities and override their compatible glob sync API instead; the new streaming regression guards against accepting an archive update that only passes ordinary buffer-based XLSX tests.

### October 31 verification

Tests use `TZ=America/Los_Angeles`; database fixtures use disposable PostgreSQL 16 clusters with `RIOSOMA_PG_BIN=/usr/lib/postgresql/16/bin`, without an external database URL.  Temporary fixtures are kept under `.ci-tools/tmp`.

- `npx --yes pnpm@11.22.0 install --frozen-lockfile`: passed on the original and final lockfiles.  Dependency resolution used the same pinned pnpm version.
- `osv-scanner scan source --lockfile pnpm-lock.yaml --lockfile integrations/zapier/pnpm-lock.yaml`: exited 0 with the verified binary on PATH, loading the root config.  The six new findings are resolved; only the original zod/deepmerge findings are filtered.  `osv-scanner.toml` and the Zapier lockfile are unchanged; no runtime or development exception was added.
- Final `pnpm why` (using the pinned invocation above) shows only follow-redirects 1.16.2, glob 14.0.2, and minimatch 11.0.1.  No glob 7/fstream/rimraf path remains.
- `python3 -m unittest discover -s tools/ci -p 'test_*.py'`: all 11 tests passed; `python3 tools/ci/check_advisory_ignores.py` passed on the unchanged config.
- `NODE_OPTIONS=--max-old-space-size=4096 npx --yes pnpm@11.22.0 turbo run build typecheck lint`: all 60 tasks passed, including ESLint's real configuration matching and the production web/Workbox service worker build.
- `npx --yes pnpm@11.22.0 --filter @riosoma/server test src/data/imports/spreadsheet.test.ts --maxWorkers=4`: all 11 tests passed, including the new streaming writer → application streaming reader round trip.
- Local fixtures exercised archiver-utils 2/3 file expansion through glob 14 (including braces, extglobs, recursive and hidden files, excludes, and basename matching); Archiver ZIP round trips with strings, buffers, streams, files, directories, and glob patterns; readdir-glob pattern/ignore/skip; filelist include/exclude; Workbox manifest generation; Fastify's async glob pre-registration and served/excluded files; and ordinary ExcelJS XLSX write/read.  A two-server loopback redirect fixture verified that cross-realm `sensitiveHeaders` removes a custom credential header and preserves an unrelated header.  All passed; local fixtures/logs remain uncommitted in `.ci-tools/`.
- `npx --yes pnpm@11.22.0 turbo run test --filter=@riosoma/db --filter=@riosoma/server -- --maxWorkers=4`: exited 1 after the full run.  Database: 69 passed.  Server: 6,745 passed, 67 skipped, two failed.  The cross-database duplication undo/redo test (`src/data/duplicate-actions.test.ts:1187`) hit its existing 60-second timeout; the updater sidecar test (`src/updates/updater-sidecar.test.ts:608`) expected `.env` mode `0640` but received `0600` under the execution environment's `0077` umask.  A focused rerun of those two files with four workers passed all 30 duplication tests and reproduced only the updater file-mode assertion (39 passed, one failed).  The timeout did not reproduce without the rest of the suite.  A detached checkout of original HEAD `1bb01f21`, installed with its original frozen lockfile, reproduced the same updater assertion (nine passed, one failed) using `npx --yes pnpm@11.22.0 turbo run test --filter=@riosoma/server -- src/updates/updater-sidecar.test.ts --maxWorkers=4`.  With a process-local `umask 0022`, the final branch's entire updater file passed all 10 tests.  No unrelated source, assertion, or timeout is changed; the original full command's nonzero result is retained here rather than reported as a pass.
- Prettier checks on the changed TypeScript and workspace YAML, and `git diff --check`, passed.

## November expiry review (October 30, 2026)

The requested failure with the two November 1 ignores removed did **not** reproduce against the October 30 advisory database. Before changing dependencies, the exact command above exited 0 both with the original four ignores and with only the two January ignores. The original scan explicitly listed the November ignores as unused. The scanner binary was downloaded into `.advisory-review/` and checked with `sha256sum -c` against the release's published `osv-scanner_SHA256SUMS`; the binary and local verification logs are not committed.

- [GHSA-vfj7-8cjw-p6xm (braces)](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) was withdrawn October 23, 2026 because the reported stack exhaustion was not considered practically exploitable. The [latest braces release](https://registry.npmjs.org/braces) is still 3.0.3, with no patched release. The [latest Lingui CLI, 6.11.0](https://registry.npmjs.org/@lingui%2fcli/6.11.0), still uses micromatch 4, which requires braces 3.0.3. There is no fixed version to override to. Since this is a withdrawn finding, retaining the existing Lingui/braces versions and removing the obsolete exception needs no replacement or new risk acceptance; it does not claim to patch braces. Extraction and compilation exercise the existing consumer.
- [GHSA-hp3w-g68c-fv3c (sprintf-js)](https://github.com/advisories/GHSA-hp3w-g68c-fv3c) was withdrawn October 22, 2026 because applications are responsible for handling formatting exceptions. The [latest sprintf-js](https://registry.npmjs.org/sprintf-js) remains 1.1.3, with no patched release. A newer consumer offers a dependency fix anyway: [tedious 20.3.8](https://registry.npmjs.org/tedious/20.3.8) no longer depends on sprintf-js. The workspace override moves tedious from 20.0.0 to 20.3.8, within [mssql 12.7.2's declared `^19.2.2 || ^20.0.0` range](https://registry.npmjs.org/mssql/12.7.2), and also satisfies @types/mssql's `*` range. The lockfile contains no sprintf-js afterward. No formatter alias or SQL Server connector rewrite is needed.

Both November exceptions are removed. The January 31 zod 3 and deepmerge exceptions and their exposure assessments below remain unchanged.

## Expiry checks and scheduled scans

`python3 tools/ci/check_advisory_ignores.py` reads the repository-root `osv-scanner.toml` with Python 3.11+'s standard-library TOML parser; it needs no dependency install. Every ignore must have a nonblank string `reason` and an `ignoreUntil` TOML date or timestamp with an explicit timezone. Local dates mean midnight UTC. Missing/invalid fields, expired ignores, unreadable or malformed TOML, and expirations more than 120 days from the current UTC time fail the check. The 120-day boundary is inclusive. Each ignore expiring within 21 days (inclusive) emits a GitHub Actions `::warning` annotation naming the advisory and expiry. The checker never extends an exception.

CI's `security` job runs the checker's unit tests, then the checker, then the existing exact two-lockfile scan. Run the tests locally with `python3 -m unittest discover -s tools/ci -p 'test_*.py'`. The January exceptions enter the warning window on January 10, 2027 and expire at January 31, 2027 00:00 UTC.

The existing `.github/workflows/nightly.yml` schedule is `0 9 * * *` (daily at 09:00 UTC), restricted to `adachis/riosoma-dev`. Previously it tested browsers, integrations, database compatibility, connectors, and an image scan; the image scan checked only fixable high/critical vulnerabilities. It did **not** run the source advisory scan for both lockfiles. The new independent `security` job runs the same expiry tests/checker and exact OSV command, without waiting for browser builds or using `continue-on-error`. A newly reported, unignored finding exits nonzero and marks the job and Nightly workflow failed on the next scheduled run, even without a PR or lockfile change. Warnings appear as Actions annotations before the expiry becomes a failure. Delivery of notifications depends on maintainers' GitHub notification settings.

[GitHub's schedule documentation](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule) says schedules run from the default branch and can be delayed; these workflow changes must reach that branch to run automatically. Daily scanning cannot guarantee detection before a PR submitted between runs, so PR CI retains the same scan.

## Weekly dependency updates

On October 30, 2026, [GitHub's documented Dependabot support](https://docs.github.com/en/code-security/reference/supply-chain-security/supported-ecosystems-and-repositories#pnpm) includes pnpm 11 (as well as 7–10 and 12), so the pinned 11.22.0 is supported. `.github/dependabot.yml` uses the documented `npm` ecosystem for pnpm, with separate weekly update entries for `/` and `/integrations/zapier`, targeting `dev`. Each groups all patch/minor version updates and excludes major version updates. The root workspace already excludes Zapier, which keeps its own lockfile. These are reviewable update PRs, with no automatic merge. Dependabot reads its configuration from the default branch; its version-update target is explicitly `dev`. Security updates still operate on the default branch under [GitHub's target-branch rules](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference#target-branch).

## Expiry-review verification (October 30, 2026)

- Downloaded `osv-scanner_linux_amd64` v2.6.0 and `osv-scanner_SHA256SUMS` from the tagged release; the matching `sha256sum -c` check passed with the SHA-256 above. The original scan passed with four ignores. Removing just the November ignores before changing dependencies also passed, consistent with the two upstream withdrawals; the requested failure could not be reproduced.
- `npx --yes pnpm@11.22.0 install --frozen-lockfile`: passed before changes and after regenerating the lockfile with the tedious override.
- `osv-scanner scan source --lockfile pnpm-lock.yaml --lockfile integrations/zapier/pnpm-lock.yaml`: passed with the verified binary on PATH, loading the root config and filtering only the two January findings. Temporarily removing the remaining ignores made that same command exit 1 and report zod 3/deepmerge, confirming the scheduled command's failure behavior; the config was then restored.
- `TZ=America/Los_Angeles python3 -m unittest discover -s tools/ci -p 'test_*.py'`: all 11 tests passed. The checker passes on the final config. Running it against the saved original config produced one Actions warning for each November ignore. Tests cover missing/blank reasons, missing/invalid expirations, date and offset timestamp formats, expiry and 21/120-day boundaries, every-ignore reporting, escaped annotations, malformed/missing files, and exit codes.
- `NODE_OPTIONS=--max-old-space-size=4096 npx --yes pnpm@11.22.0 turbo run build typecheck`: all 38 tasks passed.
- With `TZ=America/Los_Angeles`, `npx --yes pnpm@11.22.0 --filter @riosoma/web run i18n:extract` and `npx --yes pnpm@11.22.0 --filter @riosoma/web exec lingui compile --config ../../lingui.config.ts`: passed. Extraction counted 9,120 messages and emitted dynamic-message warnings, with no catalog diff; the standalone compiler's generated JavaScript was removed after verification.
- `TZ=America/Los_Angeles RIOSOMA_PG_BIN=/usr/lib/postgresql/16/bin npx --yes pnpm@11.22.0 --filter @riosoma/connectors test --maxWorkers=2`: 1,335 passed, 202 live-service tests skipped without credentials, after building testkit. This includes the SQL Server contract fixture and imports the real mssql/tedious stack. A separate local TCP smoke fixture also exercised the built SQL Server connector with the real tedious driver: it sent a TDS PRELOGIN packet and handled the fixture disconnect without leaking the supplied disposable password. No existing database was used. Full SQL Server queries and live Fabric authentication still require the credential-gated suites.
- The CI formatting command's Prettier check on all changed files (`npx --yes pnpm@11.22.0 exec prettier --check <changed files> --ignore-unknown`), `git diff --check`, and CI's actionlint v1.7.7 command on every workflow passed. Prettier's existing ignore rules exclude tools, Markdown, and the lockfile; Python syntax and behavior are checked by unittest.

## Updates

- `seroval`: 1.6.7 → 1.6.11, the first release fixing all five reported advisories; overridden for TanStack Router and seroval-plugins.
- `toml`: 4.3.0 → 5.0.1, the first release fixing all four reported advisories; overridden for `snowflake-sdk` 3.3.0.
- `undici`: 7.29.1 → 7.30.1, overridden for Miniflare through Wrangler, the hub's development and deployment tooling.
- `vite`: 8.3.1 → 8.3.3 in each of its seven direct consumers.
- `zod`: 4.6.5 → 4.6.6 in the contracts and server packages; their compatible transitive consumers also resolve to 4.6.6.

The `toml` override was introduced in commit `a89a99f` to replace Snowflake's `^3.0.0` dependency because of earlier recursion and prototype-pollution advisories.  Removing it would restore a vulnerable version.  Version 5.0.1 retains the CommonJS `parse(input, options)` API used in Snowflake's `dist/lib/configuration/connection_configuration.js`.  Its major-version change rejects integers outside JavaScript's safe range instead of silently rounding them.  Riosoma passes explicit connection options to `snowflake.createConnection`, so it does not use the driver's local `connections.toml` loader.  The loader's ordinary strings, booleans, and small numeric settings remain compatible.

## Follow-up remediation

The baseline CI command reproduced 35 advisories across the 18 affected package versions below and exited 1.  After these updates it exits 0, loading the repository-root `osv-scanner.toml` automatically for both explicitly named lockfiles.  The Zapier lockfile still has no findings and is unchanged.

| Package | Previous | Updated | Resolution |
| --- | --- | --- | --- |
| `happy-dom` | 20.14.5 | 21.0.4 | Direct development dependency in web, grid-core, i18n, icons, rio, tokens, and ui |
| `@modelcontextprotocol/sdk` | 1.31.0 | 1.32.0 | Direct server dependency |
| `follow-redirects` | 1.16.0 | 1.16.1 | Workspace override |
| `body-parser` | 2.3.0 | 2.4.0 | Workspace override |
| `postal-mime` | 4.0.5 | 4.0.8 | Direct server dependency |
| `nodemailer` | 10.0.10 | 10.1.4 | Direct server dependency |
| `ip-address` | 10.7.2 | 10.7.4 | Workspace override |
| `qs` | 6.16.0 | 6.16.1 | Workspace override |
| `fast-uri` | 3.1.8 / 4.2.1 | 3.1.9 / 4.2.3 | Overrides preserve each major line |
| `@vitest/mocker` | 5.0.2 | 5.0.3 | Workspace override |
| `@hono/node-server` | 2.1.1 | 2.1.3 | Workspace override |
| `hono` | 4.13.9 | 4.13.11 | Workspace override |
| `fastify` | 5.12.5 | 5.12.6 | Direct server dependency |
| `serialize-javascript` | 7.1.2 | 7.1.3 | Workspace override |
| `@azure/msal-node` | 6.0.1 | 7.1.0 | Workspace override; compatibility review below |
| `zod` | 3.25.76 | Unchanged | Development-only n8n peer; temporary ignore below |
| `deepmerge` | 4.3.1 | Unchanged | Build-only Rollup dependency; temporary ignore below |

The lowest fixes reported for happy-dom (20.14.6) and nodemailer (10.0.13) fix only some of their advisories.  The complete fixes are happy-dom 21.0.4 and nodemailer 10.1.4.  Happy DOM's [21.0 migration](https://github.com/capricorn86/happy-dom/releases/tag/v21.0.0) disables CSS and iframe network loading by default; this repository uses it only for tests, which do not need that network loading.  Its seven direct consumers' test suites verify compatibility without restoring the unsafe defaults.  The CodeBody message-bridge test now supplies its stand-in frame window explicitly instead of relying on an iframe load to create it; all origin, source, channel, and authorization assertions are unchanged.

## MSAL 7 compatibility

The [MSAL Node 7 migration notes](https://github.com/AzureAD/microsoft-authentication-library-for-js/blob/dev/lib/msal-node/docs/v7-migration.md) remove `InteractiveRequest.responseMode` and require form POST responses in the interactive browser-loopback flow.  Confidential-client grants and manually hosted authorization-code flows retain their API.  Riosoma has no direct MSAL imports or calls to `acquireTokenInteractive`, so there is no application API call to rewrite.

The dependency path is `@azure/identity` 4.13.3 → MSAL, through:

- `packages/db/src/tokens.ts`: PostgreSQL Entra authentication and Azure service tokens, using client secrets, certificates, workload identity, or managed identity.  `azure-tokens.test.ts` exercises the real Azure Identity/MSAL implementations with a fake HTTP transport, including grant construction, certificate assertion signatures, caching, refresh, rejected credentials, and SQL Server's default credential chain.
- `mssql` → `tedious`: SQL Server/Fabric service-principal secrets or `DefaultAzureCredential`; neither uses interactive browser authentication.  The latter's managed/workload/environment credentials use the same supported noninteractive APIs.
- `snowflake-sdk`: Azure workload attestation is available upstream, but Riosoma's Snowflake connector configures only password or key-pair authentication.

Microsoft/Entra single sign-on in `apps/server/src/auth/sso/{flow,oidc}.ts` uses `openid-client`, with its own guarded callback.  Microsoft SharePoint, Excel, and Dataverse connectors in `packages/connectors/src/microsoft/client.ts`, and Graph mail in `apps/server/src/mail/graph.ts`, implement client-credentials HTTP grants directly.  Cosmos DB takes an existing token.  These paths do not depend on MSAL's browser-loopback behavior; their tests are included in verification.

## Temporary exceptions through January 31, 2027

Each exception names the consumer, advisory, expiration, and exposure.  The one remaining exception, for zod, is in `integrations/n8n/osv-scanner.toml`, beside the lockfile that holds zod 3.  It accepts one finding temporarily.  It does not claim to fix the affected library.

### Zod 3: GHSA-mrhx-c7xc-m3w5

`n8n-workflow` 2.40.1 declares an exact `zod` 3.25.76 peer dependency; its `@n8n/expression-runtime` 0.31.1 also resolves to that version.  The [published npm metadata](https://registry.npmjs.org/n8n-workflow) was checked across all releases, including stable 2.45.3, beta 2.46.2, and the 3.0.1 release candidate: none supports zod 4.  Those current releases still pin 3.25.76.  Updating n8n cannot resolve this advisory, and overriding its peer to zod 4 would violate its supported interface, so the development dependency stays at 2.40.1.

[GHSA-mrhx-c7xc-m3w5](https://osv.dev/GHSA-mrhx-c7xc-m3w5) permits excessive validation-error allocation on oversized collections.  Riosoma uses n8n-workflow only to build and test the integration; the published node has no runtime dependencies and uses the host n8n installation's copy.  Riosoma never evaluates n8n expressions or attacker-controlled schemas during these builds/tests, and this dependency is not shipped in the server.  This does not fix a vulnerable n8n host or make untrusted workflows safe.  Recheck upstream zod support before the ignore expires.

### Deepmerge: GHSA-gcqx-w48m-w2h4 (removed November 14, 2026)

The only dependency path was web's development dependency `vite-plugin-pwa` → `workbox-build` 7.4.1 → `@rollup/plugin-node-resolve` 16.0.3 → `deepmerge` 4.3.1.  The web app now writes its own service worker at build time (`apps/web/build/service-worker.ts`), so that plugin, Workbox, and deepmerge are no longer installed, and the ignore is removed from the scanner config.

The former braces and sprintf-js ignores have been removed as described in the October 30 review above.

## Previous dependency-update verification (October 29, 2026)

All tests ran with `TZ=America/Los_Angeles`; database tests used disposable clusters with `RIOSOMA_PG_BIN=/usr/lib/postgresql/16/bin`.  Server and database test invocations used `--maxWorkers=2`; the server suite was limited to the following targeted groups.  The final UI/n8n run used four workers.

- `npx --yes pnpm@11.22.0 install` and `npx --yes pnpm@11.22.0 install --frozen-lockfile`: passed.  The reported eslint peer mismatch in n8n's lint plugin predates these changes.
- `osv-scanner scan source --lockfile pnpm-lock.yaml --lockfile integrations/zapier/pnpm-lock.yaml`: passed with the verified v2.6.0 binary on PATH, no explicit config flag, and only the two documented findings filtered.
- `NODE_OPTIONS=--max-old-space-size=4096 npx --yes pnpm@11.22.0 turbo run build typecheck`: passed across all 38 tasks.  The new database test also passed its package typecheck and lint.
- `npx --yes pnpm@11.22.0 --filter @riosoma/db test --maxWorkers=2`: 69 passed, including nine Azure/MSAL compatibility tests.
- `npx --yes pnpm@11.22.0 --filter @riosoma/connectors test --maxWorkers=2`: 1,335 passed; 202 live-service tests skipped without credentials, including Fabric.
- `npx --yes pnpm@11.22.0 --filter @riosoma/i18n --filter @riosoma/tokens --filter @riosoma/icons --filter @riosoma/ui --filter @riosoma/rio --filter @riosoma/grid-core --filter @riosoma/web --filter n8n-nodes-riosoma --workspace-concurrency=2 -r test --maxWorkers=4`: 5,180 passed across all seven DOM consumers and n8n; one web test skipped.  Web alone passed all 411 files with 4,324 tests.  The CodeBody fixture adjustment also passed its targeted rerun and lint.
- `npx --yes pnpm@11.22.0 --filter @riosoma/server test src/mcp src/mcp-client src/data/remote-tools.test.ts src/ai/schema-output.test.ts src/http/app-config.test.ts src/http/session-streams.test.ts --maxWorkers=2`: 123 passed.
- `npx --yes pnpm@11.22.0 --filter @riosoma/server test src/data/files/storage.test.ts --maxWorkers=2`: 19 passed, including the existing managed-identity endpoint test; four external-store tests skipped.
- `npx --yes pnpm@11.22.0 --filter @riosoma/server test src/mail src/auth/mail-config.test.ts src/routines/email.test.ts src/notifications/email.test.ts src/reports/email.test.ts src/bookings/email.test.ts src/ingest/extract --maxWorkers=2`: 221 passed; three credential-gated tests skipped.
- `npx --yes pnpm@11.22.0 --filter @riosoma/server test src/auth/sso src/sources/microsoft.test.ts src/sources/microsoft.live.test.ts src/sources/nosql.test.ts src/sql/routes.test.ts src/sql/guard.test.ts --maxWorkers=2`: 308 passed, three live tests skipped, and one pre-existing failure described below.

The SSO test `src/auth/sso/flow.test.ts:306`, “opens the same session a password does,” fails its calendar-day expiry assertion across the November DST transition.  Application code creates sessions with `30 * interval '24 hours'`, but the test compares with `interval '30 days'`.  The same assertion fails in a separate checkout of original `dev` commit `d485812`, installed with its original frozen lockfile, using `test src/auth/sso/flow.test.ts -t 'opens the same session a password does' --maxWorkers=2` and the same timezone.  Sign-in and session creation succeed.  This unrelated test is unchanged; it is not a dependency or MSAL regression.
