# Dependencies

Riosoma installs about 1,200 packages.  This guide covers which advisories stop a build and which get a deadline instead, what every new dependency has to say for itself, how long new releases wait, and how to fix a broken package without forking it.  The [advisory review](dependency-advisories.md) records past decisions about specific advisories.

## Advisories

CI scans `pnpm-lock.yaml`, `integrations/zapier/pnpm-lock.yaml`, `apps/hub/pnpm-lock.yaml`, and `integrations/n8n/pnpm-lock.yaml` with [osv-scanner](https://github.com/google/osv-scanner) on every push, every pull request, and every night.  `tools/ci/advisory_gate.py` reads the scan and decides what each advisory means.

### What blocks

An advisory blocks the build when it is in a **shipped** package at **moderate (medium) severity or above**.  Shipped means one of three things:

- **The server image:** the production closure of `@riosoma/server`, which is what `pnpm --filter @riosoma/server deploy --prod` installs in the `Dockerfile`.
- **The connector image:** the production closure of `@riosoma/connector-service`, which is what `pnpm --filter @riosoma/connector-service deploy --prod` installs in the `Dockerfile`.
- **The web bundle:** the production closure of `@riosoma/web`.

Development tools, build tools, test helpers, and the integrations never ship in any of them, so their advisories do not block.  A low-severity advisory does not block even when it ships.

A pull request also blocks on **any advisory it adds**, shipped or not.  CI scans the pull request's lockfiles and its base branch's lockfiles with the same advisory database and fails on an advisory the base does not have for that package.

Severity comes from the GitHub advisory label when there is one, and otherwise from the CVSS score (below 4 is low, below 7 is moderate, below 9 is high, and the rest critical).  An advisory with neither counts as moderate.

### Deadlines for the rest

Every advisory that does not block gets one GitHub issue, labeled `dependency-advisory` and `severity:<level>`.  The issue names the advisory, each package and version, how the package arrives (for example `apps/connector-service > @riosoma/connector-drivers > @databricks/sql > … > basic-ftp`), the severity, and the due date.  The deadline counts from the day the advisory was first seen and follows the FedRAMP remediation windows:

| Severity | Due |
| --- | --- |
| Critical | 30 days |
| High | 30 days |
| Moderate | 90 days |
| Low | 180 days |

Pushes to `dev` and the nightly keep the issues current.  They open an issue for a new advisory, comment and update the issue when its severity, packages, or blocking status change, reopen it (with its original first-seen date) if the advisory comes back, and close it once the advisory is gone.  Pull requests never write issues.

**The nightly fails once an issue is past due and its advisory is still reported,** and keeps failing until the package is fixed or the advisory is ignored with a reason.  That is what holds the deadline.

### Ignoring an advisory

`osv-scanner.toml`, and a separate workspace's own `osv-scanner.toml` beside its lockfile (the n8n node has one), still list advisories the scan accepts for now, each with a reason and an `ignoreUntil` date at most 120 days away.  `tools/ci/check_advisory_ignores.py` enforces both.  An ignored advisory drops out of the scan, so its issue closes, and it comes back with its old first-seen date if the ignore expires.

### Running the gate yourself

```sh
bash tools/ci/scan_advisories.sh . /tmp/advisories.json
python3 tools/ci/advisory_gate.py --scan /tmp/advisories.json
```

The gate prints a table of every advisory with its decision and exits 1 when something blocks.  To see what a branch adds, put the base branch's lockfiles in a folder with `bash tools/ci/base_lockfiles.sh dev /tmp/base`, scan that folder the same way, and pass `--base-scan` and `--base-root`.

## New dependencies

### Give every direct dependency a reason

`dependency-reasons.toml` at the repository root has one table per package directory and one line per direct dependency:

```toml
["apps/server"]
fastify = "The HTTP server and router for the API."
pino-pretty = "Readable single-line logs in development, loaded by name as pino's transport."
```

When you add a dependency, add its line in the same pull request.  Say what Riosoma uses it for, in a sentence someone could check by reading the code.  When you remove a dependency, remove its line.  Workspace packages (`workspace:*`) need no line.  CI fails when a direct dependency has no reason, or when the file lists one that nothing declares anymore.

### Use what you declare

`tools/ci/check_dependencies.py` fails when a package declares a dependency that its source, configs, and scripts never use.  A dependency counts as used when one of these is true:

- A file in the package refers to it by name in quotes, as an import, a `require`, a config string, or a CSS `@import`.  The root package's dependencies serve the whole repository, so any file counts for them.
- A script in `package.json` runs one of its commands, or (for the root) a workflow or shell script does.
- It is `@types/x` and the package uses `x`, lists `x` in a tsconfig `types` array, or (for `@types/node`) imports a Node built-in.
- It is `react` and the package has JSX files, which import `react/jsx-runtime` without naming it.
- It is a required peer dependency of something the package uses, which pnpm needs declared.

Some uses are invisible to that scan, such as a plugin a tool loads by a computed name.  Mark those in the same file with an inline table that keeps the reason and says how it is used:

```toml
babel-plugin-react-compiler = { reason = "Compiles components with the React Compiler.", unseen = "Loaded by name through reactCompilerPreset() from @vitejs/plugin-react in vite.config.ts." }
```

Run both checks locally with `python3 tools/ci/check_dependencies.py`.

### See what a change brings

On a pull request that changes a lockfile, CI keeps one comment saying how many packages the change adds and removes, and how many packages each new direct dependency brings with it (new to the lockfile, and in all).  Later pushes edit the same comment.  Look at that count before you merge, since every package added is one more to keep patched.

### Newly published versions wait three days

`minimumReleaseAge` in `pnpm-workspace.yaml` is 4,320 minutes, and so is the setting in each separate workspace's own `pnpm-workspace.yaml` (the Zapier app, the hub, and the n8n node).  pnpm will not resolve a version published less than three days ago, and a frozen install refuses a lockfile entry that young.  Dependabot's `cooldown` in `.github/dependabot.yml` matches it, so its pull requests wait just as long.  The wait lets the registry and the community catch a compromised release before it reaches Riosoma.

To let one urgent security fix through early:

1. Add a `minimumReleaseAgeExclude` list with its exact version to the same `pnpm-workspace.yaml`, for example `minimumReleaseAgeExclude: ['hono@4.13.12']`.  Name the version, never the bare package, so later releases still wait.  The key stays out of the file the rest of the time, and the hub's dependency test fails while it is present, so that pull request updates the test's expectation too.
2. Install and commit as usual.  Say in the pull request which advisory it fixes and why it cannot wait.
3. Remove the list once the version is three days old.  The next dependency update is a good time.

## Patch before forking

When a dependency is broken, take these steps in order, and stop at the first that works:

1. **Fix it upstream.**  Open an issue or pull request with the maintainers, and link it from the code or the advisory review.
2. **Carry a small patch while waiting.**  Run `pnpm patch <package>@<version>`, change the files it opens, and run `pnpm patch-commit` on that folder.  pnpm records the patch under `patchedDependencies` in `pnpm-workspace.yaml` and keeps the diff in `patches/`.  Keep the patch to the fix itself, add a comment beside the entry linking the upstream issue, and delete the patch when a release includes the fix.
3. **Fork only an abandoned package,** one whose maintainers no longer answer or release.  Publish the fork under its own name, keep its license and notices, and record why in the advisory review.
4. **Rewrite only small, stable pieces,** such as a short helper whose behavior will not change.  Anything larger stays a dependency, because Riosoma would inherit every future fix it needs.
