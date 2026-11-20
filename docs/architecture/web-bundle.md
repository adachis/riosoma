# Web bundle budget

The signed-in home shell has a 250,000-byte gzip budget.  The build follows the Vite manifest's static
imports, adds the home screen if it has a separate chunk, and measures every possible active startup
catalog separately.  It includes independently gzipped HTML, bootstrap scripts, stylesheets, the browser registration client, and the visible default wordmark mask.
Shared files count once.  Dynamic features, other locales, themes, fonts, source maps, and worker code
are separate, matching the existing performance suite's shell measurement.  The home screen is
included here even when route code would otherwise be excluded by that suite.

Run `pnpm --filter @riosoma/web build` after building its workspace prerequisites.  Every production
build emits `dist/.vite/manifest.json` and `dist/bundle-report.json`, with chunk sizes, static and
dynamic imports, and module contributions.  The build reports the shell size and warns if either
the entry or the complete first-screen shell exceeds the budget.  Absolute budgets gate builds
in the hardening phase.  Until then, the nightly performance job tracks the shell and flags
regressions over 10%.  Set `RIOSOMA_ENFORCE_BUDGETS=1` to fail an oversized build now.
`build/shell-budget.test.ts` checks shared dependencies, cycles, locale isolation, bootstrap assets,
missing inputs, required brand artwork, warnings by default, and failures with enforcement enabled.

Browser budget checks measure the English release artifact separately from the all-language test
artifact.  They count every requested brand SVG and require the default wordmark to render, so
organization branding left by an earlier test cannot hide its cost.  The release shell measures
249,638 gzip bytes, including the 4,955-byte wordmark mask.  Relative path coordinates preserve
every original curve control point.  The personal menu keeps its avatar and trigger in the shell,
and loads its closed contents on focus, hover, or opening.

## Before and after

These historical measurements predate the visible wordmark's inclusion in the budget.
The original before build used the unchanged application with manifest/report output enabled.  The brief's
roughly 915 KB result and this build differ because this measurement also follows home-screen code
and the active locale.  All sizes below are bytes, with each transferred file gzipped independently.
The merged fix column measures current development changes together with the route and feature split.

| Measurement | Before split | Original split | Merged fix |
| --- | ---: | ---: | ---: |
| Entry JavaScript file alone | 83,127 | 228,956 | 229,140 |
| Entry and recursively imported JavaScript | 861,138 | 229,386 | 229,570 |
| First-screen JavaScript, including home and active en-US catalog | 1,040,378 | 234,924 | 234,477 |
| Active en-US startup catalog | 129,431 | 5,538 | 4,907 |
| Complete first-screen shell, en-US, including HTML and CSS | Not recorded | 248,704 | 248,256 |
| Largest complete shell, including pseudo-locale | Not recorded | 249,918 | 249,385 |
| Budget | 250,000 | 250,000 | 250,000 |

The merged platform list retains ClickUp, Asana, Notion, and monday.com, including each level-policy
entry and palette label.  Every server and formula descriptor remains registered when feature
messages load.  Stored formula errors without a function name retain their complete explanation.
The initial merged shell measured 250,340 bytes.  Startup catalogs now follow the home screen's static
imports instead of including translations for closed home forms and the palette, bringing every
active startup locale back under the budget.

The JavaScript comparison rows follow the static application graph and active catalog.  The complete
shell rows also include the bootstrap and browser registration client.  The final report measures
files from disk after output plugins finish rewriting chunk names and code.

The entry file becomes larger because the static shell and home dependencies are grouped together.
This removes dozens of small shared startup files and improves compression, and the complete first
screen becomes much smaller.

The largest original entry-module contributions were:

| Module | Rendered bytes before minification | After |
| --- | ---: | --- |
| RoutineForm | 37,417 | Rio/routines feature chunk |
| NotificationItem | 26,918 | Notification list feature chunk |
| AppShell | 25,213 | Static shell, closed panels are deferred |
| docs/loader | 21,750 | Help feature chunk |
| RioAssistant | 20,150 | Rio feature chunk |
| RioAvatar | 17,029 | Static launcher |
| CommandPalette | 13,849 | Palette feature chunk |
| router | 13,782 | Static route definitions |
| FeedbackDialog | 13,647 | Feedback feature chunk |
| RoutineList | 12,139 | Rio/routines feature chunk |
| feedback/capture | 12,128 | Feedback feature chunk |
| DemoLayer | 10,787 | Show-me feature chunk |

The largest original startup files included the full en-US catalog (129,431), shared rendering code
(123,824), rich-text/editor code (121,696), schema validation (76,878), the solid icon barrel (53,011),
and date-picker code (43,217).  Those shared files made an apparently small entry misleading.

The largest remaining entry-module contributions are framework code and home interactions.  Rendered
module bytes are measured before minification and cannot be added to derive transferred gzip sizes.

| Module | Rendered bytes after splitting |
| --- | ---: |
| React DOM client | 529,611 |
| Drag-and-drop core | 85,390 |
| Router client loader | 36,003 |
| Router core | 34,434 |
| Sortable controls | 31,044 |
| AppShell | 21,560 |
| FolderHome | 20,364 |
| Overlay positioning | 18,528 |
| Press handling | 17,912 |
| Route-tree processing | 17,848 |
| RioAvatar | 17,029 |
| React runtime | 16,037 |
| Route definitions | 14,061 |
| Query observer | 13,217 |

## Boundaries and behavior

Routes still use the same route tree, search parsing, access checks, record addresses, and redirects.
The home screen is part of the static shell.  Other routes load their active feature catalog alongside
the route module.  Settings load individual sections.  Views load their own view and controls.
Dashboards, automations, interface designers, and record editors have feature boundaries inside the database route.
Direct help, plan-preview, remote-approval, and record links select their boundary immediately.

Help, Show-me, Rio, the palette, feedback, notification contents, imports, sharing, folder forms,
menus, and confirmation surfaces wait for intent.  Rich-text inputs and displays load Tiptap on demand.
Existing native textareas handle code editing.  PDF export already loads pdfmake dynamically.  PDF
import, Excel, and Word tooling run through existing server paths.  No browser dependencies were added.

Buttons and links preload the next feature on hover and focus.  Rendering and preloading share one
promise.  Show-me waits for an anchored control's preload before pressing it.  Visible menu and popover
buttons stay mounted as their content loads, preserving their identity and focus.  Page and panel
fallbacks fill their slots, controls reserve their height, and modal placeholders use a passive fixed
overlay so they do not capture or restore focus before the actual dialog is ready.  Rio's placeholder
uses its final dock geometry.  Rich-text placeholders render the document and toolbar with the
editor's styles, preserving the position of following fields while Tiptap loads.  All loading text uses a Lingui ID and all new styles use theme tokens.

Show-me starts after its lazy controls mount, journals settled surfaces instead of loading shells,
and waits for dialog entry animations before restoring its own controls.  Ending a demo restores the
help button after closing focus scopes finish.  Startup checks setup status before requesting a private
session, preserving the fresh-install redirect without an unauthorized request.

Only the active startup catalog loads before interaction.  Feature activation loads that locale's full
catalog and server-message descriptors.  Locale switches retain the existing language/direction behavior
and discard stale activations.  Contract constants and lightweight predicates are separate from schema
construction.  Callers needing validation still load and use the original schemas.

Background API failures decode their error metadata within the shell.  Decoding does not request
feature catalogs, descriptors, or schema chunks.  The decoder is checked against the existing error
contract for accepted codes, optional metadata, unknown properties, and malformed responses.
An error banner or toast requests feature translations only when it needs to display a specific
message.  A denied update poll therefore stays within the same budget as a successful cold start.

Attachment menus load the shared connection store when they mount, including when its empty state
initially offers no sources.  Concurrent menus share one request.  Rio consumes the launcher's initial
opening when it closes, above the boundary that resets database context on navigation.
Settings boundaries are keyed by section so leaving a form for a pending section ends its lifetime.  Returning
to file settings therefore refreshes an unedited cached upload limit, even before the
other section finishes loading.

The service worker precaches the common shell and install icons.  Hashed feature assets enter a runtime
cache when requested.  A new worker also caches the startup assets the current client already loaded,
including its active catalog, so first-install offline use does not require precaching other languages
or unopened features.

The build writes the worker itself.  `apps/web/build/service-worker.ts` is a small Vite plugin that
writes `manifest.webmanifest`, links it from the page, and writes `sw.js` from
`apps/web/build/service-worker-runtime.js` with the build's precache list.  Hashed assets are keyed by
their names, and every other precached file by a hash of its contents, so a new build replaces only
what changed.  The precache is named `rio-precache-v1-` followed by the registration scope.  Activation
removes obsolete entries from that cache, older Riosoma precaches for the same scope, and legacy
Workbox caches whose names contain both `-precache-` and the registration scope.  Runtime caches,
including `rio-app-assets`, and unrelated caches remain available.

## Original verification

The required verification command passed:

```sh
pnpm turbo run build lint typecheck --filter=@riosoma/server... --filter=@riosoma/web && pnpm turbo run test --filter=@riosoma/server... --filter=@riosoma/web -- --maxWorkers=3 && pnpm --filter @riosoma/web run i18n:extract && pnpm settings:check
```

The web suite passed 3,365 tests in 311 files, retaining its existing skipped test.  The server suite
passed 4,033 tests in 254 files, retaining its existing skips.  The changed shared UI controls passed
39 targeted tests.  Browser test types and lint also passed.

The cold-start browser check uses a fresh context with a server-selected French locale and a different
remembered locale.  It checks actual asset requests against the budget report, rejects other catalogs,
and verifies that the first installed worker caches the active startup catalog.  The editor checks hold
the Tiptap chunk open at 390 and 1280 pixels and compare editor height and the following field's position
before and after loading, with a one-pixel tolerance.  Record entrance animations and fonts settle
before the baseline is captured, including when a previous visual check selected another theme.

Accessibility checks retain every rule, tag, exclusion, and assertion.  Documents without child frames
use the direct analysis path, and a frame that appears during a scan triggers the complete frame-aware
analysis.  Pages with existing frames use that analysis from the start.  Readiness waits for the
document, lazy content, fonts, and finite animations.  Closing a native document viewer can leave
the browser's network state unsettled, even after signing completes, so network state does not
gate a scan of the finished screen.  The full suite also checks a confidence meter with its explicit
role and readable explanations for unavailable radio options.

The complete 387-case Chromium suite ran across three isolated stacks with the theme assets in
place.  It initially passed 381 cases.  The setup-dependent visual cases passed with the setup
journey included.  The upload-settings refresh regression passed after its boundary fix.  Folder
navigation and phone toolbar timing failures passed in isolated reruns at their existing timeout.

One existing grid keyboard case still exceeds its default 30-second timeout when run alone.
Its unchanged assertions and every accessibility scan passed in 27.8 seconds in a diagnostic run
using `--timeout=60000`.  The test's timeout setting remains unchanged.  The complete performance
suite was not rerun.  Shell sizes come from the final production build and cold-start browser probes.

## Merged verification

The complete required verification command passed with the existing test retry option described below:

```sh
pnpm turbo run build lint typecheck --filter=@riosoma/server... --filter=@riosoma/web --filter=@riosoma/e2e && pnpm turbo run test --filter=@riosoma/server... --filter=@riosoma/web -- --maxWorkers=3 && pnpm --filter @riosoma/web run i18n:extract && pnpm settings:check
```

New regression tests first failed for the omitted import platforms and palette entries, unnamed
formula errors, and unconditional budget failures.  They pass with the merged fixes.  All original
feature entries, levels, and holdings predicates were compared with the current base and retained.
Every original server and formula descriptor remains in its message module and joins the feature registry.

The web suite passed 3,393 tests in 312 files, retaining its existing skipped test.  The server suite
passed 4,108 tests in 261 active files, retaining its existing 26 skipped files and 52 skipped tests.
The changed shared menu, combo box, and toast controls passed 26 targeted tests.  The dashboard deep-link test
initially observed extra range requests under load and passed all seven cases unchanged when run
alone.  The final unit run uses the existing `RIOSOMA_TEST_RETRY=1` option and three workers.

The eight unit-specific Chromium cases passed.  The 62 selected existing cases for help, the
palette, views, dashboards, automations, scripts, imports, settings, interfaces, and Show-me passed
across the initial batch and isolated reruns.  Help needed its owner-account prerequisite.  Dashboard
requests, org-chart reload selection, and the scheduled-reports demo passed at their original
timeouts when rerun.  A list-row contrast failure was fixed by using the primary text token for
field values.  The list/map case then passed its unchanged accessibility assertions.

The production build also passed with `RIOSOMA_ENFORCE_BUDGETS=1`.  Browser checks used the existing
theme styles.  Theme asset directories are empty, and copying their assets would write outside
the unit's allowed file scope.  The complete Chromium suite with theme assets remains unrun
pending that scope exception.  The complete performance suite was not rerun.
