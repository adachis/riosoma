# Contributing to Riosoma

Bug reports, documentation fixes, and code contributions are welcome.  Contributions to Riosoma are accepted under the [Nice People License 1.0](LICENSE), the same license as the project.  Contributions to files marked MPL-2.0 remain under MPL-2.0.  Submit only work you have the right to contribute, and preserve existing attribution and license notices.

The license lets eligible people modify Riosoma and share modified or unmodified copies with anyone, free of charge, so patches and forks are welcome.  Every shared copy carries the license unchanged and keeps the copyright notices.  A modified version says plainly that it was changed and uses its own name and branding.  Nobody may sell a copy or charge for access or use.

## Set up from source

The [source installation guide](docs/install/from-source.md) covers the full build and server setup.  For development, use the branch you intend to contribute to.

You need Node 24 or newer, pnpm 11.22, Git, PostgreSQL 14 or newer, and about 4 GB of memory for the build.

```sh
git clone https://github.com/adachis/riosoma.git
cd riosoma
pnpm install --frozen-lockfile
pnpm turbo run build --filter=@riosoma/server... --filter=@riosoma/web
```

Create a PostgreSQL account and database as described in the source guide.  Then start the server with a writable config directory:

```sh
mkdir -p -m 700 "$HOME/.local/share/riosoma"
export RIOSOMA_CONFIG_DIR="$HOME/.local/share/riosoma"
export RIOSOMA_DATABASE_URL='postgres://riosoma:PASSWORD@localhost:5432/riosoma?sslmode=disable'
export RIOSOMA_BASE_URL=http://localhost:8080
node apps/server/dist/main.js
```

Use a local password in place of `PASSWORD`.  The config directory holds the generated instance encryption key, so keep it outside the checkout, private, and backed up.  Keep credentials out of commits.  Open the setup link in the server log to create an owner account.  For server development with the built web app, stop the compiled server and run `pnpm --filter @riosoma/server dev` with the same environment.  Either way, the server starts the connector service, which runs the sources that need their own database drivers, as a process of its own, from its TypeScript while developing.

For web development, stop the server and restart it in the first terminal with the web development server's public origin:

```sh
export RIOSOMA_BASE_URL=http://localhost:5173
pnpm --filter @riosoma/server dev
```

Keep the config and database environment variables above in that terminal.  The backend still listens on port 8080.  In a second terminal, start the web development server from the repository root:

```sh
export RIOSOMA_DEV_SERVER=http://localhost:8080
pnpm --filter @riosoma/web dev --host localhost --port 5173 --strictPort
```

Open <http://localhost:5173>.  The public origin matches `RIOSOMA_BASE_URL` for realtime and passkey validation.  The development server forwards API requests and WebSocket upgrades, including realtime and script runs, to the backend on port 8080.  `--strictPort` prevents an occupied port from silently changing the public origin.  When returning to the built web app on port 8080, restore `RIOSOMA_BASE_URL=http://localhost:8080` and restart the backend.

## Run checks

Before submitting a change, run this from the repository root:

```sh
pnpm turbo run build lint typecheck --filter=@riosoma/server... --filter=@riosoma/web --filter=@riosoma/e2e && pnpm turbo run test --filter=@riosoma/server... --filter=@riosoma/web -- --maxWorkers=3 && pnpm --filter @riosoma/web run i18n:extract && pnpm settings:check
```

Tests use Vitest.  Database tests start temporary PostgreSQL clusters and create isolated databases.  If the binaries are not found automatically, set `RIOSOMA_PG_BIN` to their directory.  Alternatively, point `RIOSOMA_TEST_DATABASE_URL` at a dedicated test server whose account can create and drop databases.  Never point tests at an instance containing data you want to keep.

Run the relevant workspace or test file while developing.  For example:

```sh
pnpm --filter @riosoma/server exec vitest run src/data/undo.test.ts --maxWorkers=3
```

The [property testing guide](docs/developer/property-tests.md) explains generated command sequences and how to reproduce failures.  UI changes should also follow the [accessibility and performance checks](docs/architecture/performance-accessibility.md), which describe the browser suites and their prerequisites.  Keep existing tests and add a regression test when fixing a behavior that could fail again.

Before adding, removing, or patching a dependency, read the [dependency guide](docs/developer/dependencies.md).  Every direct dependency needs a reason in `dependency-reasons.toml`, newly published versions wait three days, and CI decides which advisories block a build and which get a dated issue.

The standard server test run also checks the release files' relative links and production dependency licenses.  To regenerate notices after an authorized dependency change, run `node tools/licenses.mjs`.  `node tools/licenses.mjs --check` validates the installed dependency licenses without writing files.  Platform-specific optional dependencies reflect the machine running the script, so generate the release notice file on the release target.

## Code and writing conventions

- Write TypeScript, use explicit types where they clarify a boundary, and use type-only imports.  ESLint requires consistent type imports and rejects unused variables, except intentionally unused names beginning with `_`.
- Follow the formatter: single quotes, semicolons, trailing commas, and a 110-character print width.  Run `pnpm exec prettier --write` on the files you changed.
- Follow the existing React hooks rules.  Use in-app dialogs and toasts for confirmations and messages.  Native `alert`, `confirm`, and `prompt` dialogs are forbidden by lint.
- Route product text through explicit Lingui message IDs, following nearby components.  Extract catalogs with the command above.  Help topics use `{{ui:message.id}}` references for interface labels and `{{keys:shortcut.id}}` for shortcuts.
- Use existing theme tokens for styles, as described in the [web bundle guide](docs/architecture/web-bundle.md).  Keep controls keyboard-accessible and loading states stable.
- Write calm, direct American English.  Explain what a person can do and what will happen.  Use a serial comma and two spaces between sentences.  Comments explain a reason or constraint that the code alone cannot show.
- Keep changes focused.  Avoid unrelated formatting, dependency changes, generated assets, credentials, private data, personal machine paths, and development-process attribution.

## Report bugs and propose changes

Search [existing issues](https://github.com/adachis/riosoma/issues) before opening a report.  Include your Riosoma version, install method, browser if relevant, reproduction steps, expected behavior, and actual behavior.  Attach a small example or redacted logs when they help.  Use the [security policy](SECURITY.md) for vulnerabilities.

For a substantial change, open an issue describing the problem and intended behavior first.  In a pull request, explain the user-visible result, the reason for the change, and the checks you ran.  Call out any remaining limitations.  Contributions must keep the applicable license and third-party notices intact.
