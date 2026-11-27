# Releasing Riosoma

Current release: **v0.95.0**.

Development stays in `adachis/riosoma-dev`.  Each public release is a single commit containing the private checkout's files, without its development history.  Public tags in `adachis/riosoma` run the release workflow on GitHub-hosted runners.  The commands below describe publishing steps for a maintainer.  Preparing this pipeline does not run them.

1. Choose a semantic version, with no leading `v`, from a clean private checkout.  Use Node 24 or later and the pnpm version in the root manifest.

   ```bash
   VERSION=0.95.0
   node tools/release/version.mjs "$VERSION"
   ```

   This updates workspace package versions, the server's default reported version, the Docker build's default version, both Compose images, the Helm chart and app versions, the REST and MCP connector API definitions, and current release examples in the install docs.  Package manifests change only their `version` fields.  The independently released Zapier integration keeps its version.  The command accepts prereleases such as `0.96.0-rc.1` and rejects invalid versions.  `node tools/release/version.mjs "$VERSION" --check` detects drift without writing files.  Existing changelog entries, asset checksums, and the independent `0.0.0-dev` smoke-test example are preserved.

2. Add `## [<version>] - YYYY-MM-DD` to `CHANGELOG.md`, followed by the release's notes.  Add this version to `tools/release/releases.json`, with `date`, `security`, and `minimumVersion`.  The date must match the changelog date.  `minimumVersion` is the oldest install allowed to update directly to this release.  For the first public build it is the release itself.  Mark `security` true only for a release that fixes a security problem.  These files produce release notes and update feed metadata.

3. Prepare the theme asset bundle from the maintained local asset collection.  Its layout is `<theme>/assets/...`, matching the paths in each theme's manifest.  The input can also be a populated `themes/` directory, whose stylesheets and manifests are excluded from the archive.

   ```bash
   node tools/release/pack-theme-assets.mjs "$VERSION" /path/to/theme-assets "/tmp/$VERSION.tar.zst"
   ```

   This produces the compressed archive and updates `themes/assets.lock.json` with its SHA-256 and byte length.  The archive contains only regular asset files, with deterministic ordering and metadata.  Symlinks and unsafe paths are refused.  Keep the bundle outside the checkout.  Upload it through the asset hosting process to `https://assets.riosoma.com/themes/<version>.tar.zst` before publishing the tag.  Asset hosting credentials are separate from the update feed credentials.

   ```bash
   node tools/release/fetch-theme-assets.mjs "$VERSION" --required
   ```

   This verifies the downloaded bytes before unpacking into `themes/`.  A mismatched checksum, unsafe archive, or network failure stops the build.  Without `--required`, a missing bundle or manifest entry leaves themes available with system fonts.  CI uses that fallback, and release builds require the bundle.  The Docker build copies these files from its build context, so fetch before building an image.  The Node scripts use built-in Zstandard support and need no additional dependencies.

4. Run the local checks and standard verification.  No publishing credentials are needed.

   ```bash
   pnpm install --frozen-lockfile
   pnpm turbo run build --output-logs=errors-only
   node --test tools/release/*.test.mjs
   actionlint .github/workflows/*.yml
   node tools/i18n_check.mjs --allow-missing
   pnpm turbo run build lint typecheck --filter=@riosoma/server... --filter=@riosoma/web --filter=@riosoma/e2e && pnpm turbo run test --filter=@riosoma/server... --filter=@riosoma/web -- --maxWorkers=3 && pnpm --filter @riosoma/web run i18n:extract && pnpm settings:check
   ```

   Install actionlint v1.7.7 if needed with `go install github.com/rhysd/actionlint/cmd/actionlint@v1.7.7`.  It is MIT licensed.  The existing Prettier YAML parser checks action SHA pins, version comments, and explicit job permissions in the test suite.  Server tests check `/healthz` and serving a theme without its assets.  The first releases ship in English, so CI validates the en-US catalog and existing translations while permitting untranslated messages to use English fallbacks.  Invalid ICU syntax, mismatched placeholders, unknown keys, and changed product names still fail validation.  Asset tests cover a reproducible round trip, checksum refusal, missing-bundle fallback, and destination symlink refusal.  `/healthz` must report the selected version.  Commit the resulting private release preparation.

5. Configure the repositories before the first export.  Set `RIOSOMA_RUNNER` in the private repository's Actions variables to `riosoma`, the self-hosted runner's label.  Leave it unset in the public repository to use `ubuntu-latest`.  CI installs Node, pnpm, PostgreSQL 16 and 18, Playwright browsers, semgrep, osv-scanner, and gitleaks on hosted runners.  Nightly jobs require `github.repository == 'adachis/riosoma-dev'` and remain private.  Public repository settings must permit its workflow token to write packages and releases, and permit OIDC for keyless signing.  Make the image and chart packages public after their first publication so installs can pull them without credentials.

   For the feed, set public repository secrets `RIOSOMA_FEED_SIGNING_KEY`, `RIOSOMA_FEED_R2_ACCOUNT_ID`, `RIOSOMA_FEED_R2_ACCESS_KEY_ID`, and `RIOSOMA_FEED_R2_SECRET_ACCESS_KEY`.  Grant the R2 credentials access only to objects in `riosoma-feed`.  The signing secret is an Ed25519 private key in the PEM, raw base64url seed, or base64url PKCS#8 form accepted by `tools/sign-feed.mjs`.  It must match key ID `2026-10` in the server's trusted keys and `deploy/updater/feed-keys.json`.  Rotate the trusted public keys in a preceding release before switching the signing key and workflow key ID.  Absent credentials produce an explicit notice and skip feed publishing while the other release artifacts proceed.

6. Export the committed private tree into a separate, fresh public checkout.  This produces one new public commit, whose parent is the preceding public release commit.  Review the complete exported files before committing, including the changelog, checked-in theme checksum, and workflows.  Do not include private credentials or unpublished files.  The source export uses tracked files only, so it excludes local asset bundles and caches.

   ```bash
   git clone https://github.com/adachis/riosoma.git /tmp/riosoma-public
   if git -C /tmp/riosoma-public rev-parse --verify HEAD >/dev/null 2>&1; then
     git -C /tmp/riosoma-public switch main
   else
     git -C /tmp/riosoma-public symbolic-ref HEAD refs/heads/main
   fi
   git -C /tmp/riosoma-public rm -r --ignore-unmatch .
   git archive HEAD | tar -x -C /tmp/riosoma-public
   git -C /tmp/riosoma-public add --all
   git -C /tmp/riosoma-public diff --cached --stat
   git -C /tmp/riosoma-public commit -m "Release Riosoma $VERSION"
   git -C /tmp/riosoma-public push origin main
   ```

   Wait for the public CI run to pass.  Keep releases in increasing version order because `latest`, the major/minor tag, and the feed are shared.  The workflow serializes releases to prevent concurrent feed updates.

7. Tag that reviewed public commit and push the tag.  This starts publishing, so do this only after CI passes and the theme bundle is accessible.

   ```bash
   git -C /tmp/riosoma-public tag -s "v$VERSION" -m "Riosoma $VERSION"
   git -C /tmp/riosoma-public push origin "v$VERSION"
   ```

   The workflow verifies that the tag matches every release version, then builds an AMD64/ARM64 image and pushes it by digest only, with no tag.  Buildx attaches an SPDX SBOM and maximum build provenance.  Trivy scans both pushed platforms by that immutable image digest and fails on fixable HIGH or CRITICAL findings.  Cosign signs the image index with GitHub OIDC after scanning.  Only then does the job point `ghcr.io/adachis/riosoma:<version>` and `:<major.minor>` at the scanned and signed digest, and confirm that each tag resolves to it.  Stable tags also update `:latest`.  Prereleases retain the major/minor alias and are marked as prereleases on GitHub.  A failed tool download, scan, or signature leaves every tag where it was.  Helm packages the chart and pushes `riosoma:<version>` to `oci://ghcr.io/adachis/charts`.

   Cosign, Trivy, and Helm are downloaded at pinned versions and must match the SHA-256 checksums recorded in `tools/release/install-tools.sh`.  A checksum file published beside a download is not consulted, since whoever replaces one can replace the other.  To change a tool's version, record its new checksum in the same commit after confirming it from two independent sources.

   The feed job resolves the executable image digest for each platform, verifies existing feed history, replaces any entry for this version, signs the exact payload with `tools/sign-feed.mjs`, and uploads `updates.json` to R2.  It keeps at most 500 entries and prunes the oldest entries until the serialized envelope fits the update client's 2,000,000-byte download limit, including UTF-8 bytes, JSON escaping, the signature, and the key ID.  The upload check verifies the final signed envelope's byte size and trusted signature before upload.  Errors reading an existing feed stop publication instead of silently discarding history.  A wrong signing key stops publication.  The last job creates the GitHub release using only this version's changelog section.

8. Check the published image signatures and attestations, chart version, release notes, public package visibility, and signed feed.  Test a fresh install and confirm `/healthz` reports the release version.  The existing update protocol considers feeds stale after 14 days, so the feed needs periodic re-signing through the maintained feed publishing process between releases.  A failed scan or publishing job requires maintainer review before rerunning the failed jobs.  Do not move an existing version tag or silently replace a published bundle.
