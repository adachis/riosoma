# Performance and accessibility gates

Build the production server and web app before either browser suite:

```sh
pnpm turbo run build --filter=@riosoma/server... --filter=@riosoma/web
pnpm --filter @riosoma/e2e typecheck
pnpm --filter @riosoma/e2e lint
pnpm --filter @riosoma/e2e e2e
pnpm --filter @riosoma/e2e perf
```

Run performance on a quiet, dedicated runner, after the other build and test jobs finish.  Do not
rebuild the web output while a browser suite is using it.  The performance config uses one Chromium
worker, no retries, no tracing, and no service worker.  It starts the existing isolated server and
PostgreSQL stack, then inserts exactly 1,000,000 records with 20 populated fields into an API-created
table.  Fixture creation and warmup are outside the measurements.

The first-row measurement includes a warm browser reload through the first rendered record.  A jump
uses the grid's content-pixel wheel path to reach record 900,000.  The indexed sort opens a sorted view after an
unmeasured warmup.  Reloads, jumps, indexed sorts, and five-second scrolling trials each have one
unmeasured warmup and five measured repetitions.  Their reported values are medians with raw samples.
Scrolling records actual animation-frame intervals while the grid reads real pages, with and without
sparklines.  Thirty committed edits after one warmup edit measure local
cell rendering, accepted command responses, and visible updates in a second browser process.  Both
browsers use the same monotonic epoch clock, avoiding test-runner polling time in the measurements.

The shell measurement adds independently gzipped production HTML, boot scripts, statically preloaded
JavaScript, and stylesheets.  Route bundles, themes, and fonts are separate.  KB means 1,000 bytes, so
the shell limit is 250,000 bytes.  Layout-shift observers start before application scripts, retain every
unexpected shift, and include font readiness and final paint delivery on the main screens at desktop
and phone widths.  Any positive shift fails.

`apps/e2e/perf/results/report.json` contains raw samples, summaries, budget failures, and
regressions, plus the asset sizes and shifts by screen.  `last.json` is replaced atomically only by a passing run.  The report directory survives the regular e2e suite's output cleanup.  An absent default baseline
bootstraps a first run; an explicitly requested missing baseline fails.  Set `RIOSOMA_PERF_BASELINE`
to a downloaded previous passing report and `RIOSOMA_PERF_REPORT_DIR` to the artifact directory.
The baseline embeds the last five quiet passing reports, so runners that copy only `last.json`
retain the comparison history.  Legacy reports still work as a one-report history.  Each regression
comparison uses raw sample medians and reports the current median, the historical median, every
passing median, and the metric's tolerance.  A regression fails only when it exceeds the tolerance
against every passing median.  Latency metrics use a 25% tolerance, while scrolling frame rate and
frame p95 use 5%.  Shell size and layout shift retain their 5% tolerances.  Stability comes from
repeated samples, the quiet passing history, and skipping comparisons under load.  The busy-machine
figures below explain the load rule and are not the basis for the tolerances.  The same figures are
beside `TOLERANCES` in `metrics.ts`.

The original absolute budget statistics still apply independently: maximum latency, minimum frame
rate, p95 tails, shell size, and every layout shift.  A good median never hides an over-budget sample.
Each measurement records the one-minute load average before and after its operation.  The load limit
is 75% of the host's available logical CPU count, leaving capacity for the browser and server.  If any
reading exceeds this limit, the report is marked as taken under load and skips regression comparisons.
Absolute budgets and missing or invalid measurements still fail.  Loaded passing runs retain the
quiet history without adding their samples to it.  Preserve the baseline from the same runner and
build configuration.  The suite has a ten-minute total timeout.

Every feature spec uses the shared accessibility fixture.  It runs axe's WCAG 2.1 AA rules at full
document navigations, SPA navigation actions, and before a browser context closes, including extra
contexts opened by a spec.  Coverage follows the visible accessible tree, viewport, and theme, so
tabs, dialogs, and expanded controls invalidate it even when the URL stays the same.  Field and status
values can change without opening another screen, while labels, validation alerts, and new controls
still invalidate coverage.  Only the live-announcer scaffolding already excluded by the existing
suite is excluded.  Violations are attached as JSON and fail the test.  The dedicated accessibility
spec also checks main screens, views, record cards, dashboards, automations, and public screens with
forced colors and the `en-XB` RTL pseudo-locale at desktop and phone widths.  `en-XB` uses the extracted
`en-XA` catalog, with RTL direction, so new source messages exercise both pseudo-locales without
another catalog or a change to the root extraction config.

CI runs the build, e2e typecheck, e2e lint, and the browser smoke run (`pnpm --filter @riosoma/e2e e2e:smoke`,
the first journeys in Chromium) on every pull request and push to dev, uat, and main.  Nightly, run the whole
suite (`pnpm --filter @riosoma/e2e e2e`) with
`RIOSOMA_E2E_ALL_BROWSERS=1`, then run `pnpm --filter @riosoma/e2e perf` on the dedicated performance
runner after all other jobs on that host finish.  Also run performance before releases to main.
Download the last successful performance artifact before running; upload `report.json` on every
result and promote `last.json` only on success.  Keep failed browser reports and accessibility JSON
attachments.  Run `pnpm --filter @riosoma/grid-core test:browser` with the regular Chromium browser
job to retain the existing synthetic million-row interaction and frame benchmarks.

The workflow files remain unchanged.

## Same-build calibration on October 10, 2026

Ten sequential, complete reports below the load limit used build `2b112430` on a
development machine with 18 logical processors and other work running, with a one-minute load limit
of 13.5.  The suite ran without concurrent build or test jobs from this measurement session, but the
machine was busy with other work.  One additional report above the load limit was excluded.
Four runs passed, and six failed the existing frame p95 budget.  Failed runs were retained for the
spread but never promoted as passing baselines.  Suite durations ranged from 182.0 to 216.5 seconds.

The spread uses run medians and `(maximum / minimum - 1) × 100`, with zero for all-zero metrics.
These figures measure variation on a busy development machine, not isolated suite stability.
They explain why reports taken under load skip regression comparisons, not how tolerances are set.
The load threshold does not certify that a development machine is otherwise idle.  Latency metrics
use the decided 25% tolerance, and scrolling frame rate and frame p95 use 5%, independently of this spread.

| Metric | Ten-run minimum median | Ten-run maximum median | Ten-run spread | Final tolerance |
| --- | ---: | ---: | ---: | ---: |
| `firstRowsMs` | 116.4000 | 131.5000 | 12.9725% | 25% |
| `jumpMs` | 82.5000 | 97.6000 | 18.3030% | 25% |
| `indexedSortMs` | 111.1000 | 161.1000 | 45.0045% | 25% |
| `scrollingFps` | 59.8038 | 60.0026 | 0.3323% | 5% |
| `frameP95Ms` | 16.7000 | 16.7000 | 0.0000% | 5% |
| `localEchoMs` | 5.1001 | 6.8000 | 33.3317% | 25% |
| `acknowledgmentP95Ms` | 34.5000 | 50.5498 | 46.5212% | 25% |
| `peerP95Ms` | 32.1998 | 51.2001 | 59.0073% | 25% |
| `shellGzipBytes` | 234060.0000 | 234060.0000 | 0.0000% | 5% |
| `cls` | 0.0000 | 0.0000 | 0.0000% | 5% |

After the required build, lint, typecheck, unit tests, catalog extraction, and settings checks passed,
a full performance run passed all 15 tests in 245.6 seconds.  Its report at
`2026-10-10T19:55:48.062Z` contained no failures.  The 103 measurement boundaries recorded one-minute
load readings from 10.3462 to 16.3345, exceeding the 13.5 limit.  It skipped regression comparison
and retained the four quiet passing reports in its baseline history.  All absolute budgets passed.
That validation demonstrates the loaded-run behavior.  Comparison unit tests provide the regression
evidence, including a build 30% slower than all five passing reports on a quiet machine.

The frame median remained 16.7 ms while some p95 tails reached 16.8 ms.  The absolute frame budget
still failed those runs independently of the regression tolerance.

| Run below load limit | First rows, ms | Jump, ms | Indexed sort, ms | Local echo, ms | Acknowledgment median, ms | Peer median, ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 129.5000 | 97.6000 | 161.1000 | 6.8000 | 49.6500 | 49.4498 |
| 2 | 131.5000 | 82.5000 | 128.6000 | 5.7501 | 39.2001 | 38.1500 |
| 3 | 125.7000 | 86.5000 | 148.1000 | 5.1001 | 35.5499 | 32.1998 |
| 4 | 131.4000 | 87.1000 | 130.6000 | 6.1000 | 38.3500 | 42.5498 |
| 5 | 127.5000 | 89.6000 | 127.9000 | 5.7000 | 35.9001 | 38.8500 |
| 6 | 131.4000 | 91.4000 | 111.2000 | 5.2500 | 34.6500 | 37.0001 |
| 7 | 116.4000 | 91.6000 | 128.4000 | 5.2501 | 34.8501 | 44.9498 |
| 8 | 129.3000 | 88.0000 | 130.0000 | 5.2000 | 34.5000 | 33.7002 |
| 9 | 129.0000 | 87.6000 | 111.1000 | 5.7000 | 37.2001 | 33.5499 |
| 10 | 127.1000 | 88.3000 | 127.0000 | 6.4000 | 50.5498 | 51.2001 |

A further validation after the unit suite measured first rows at 180 ms and indexed sorting at
196.6 ms on the same build.  Its one-minute load readings were 9.4878–12.2642, below the 13.5 limit.
That observation widened the measured spread on the busy development machine, even though load
readings remained below the threshold.  It does not widen the tolerances.  It still failed the
unchanged frame p95 budget.

| Metric | Expanded minimum median | Expanded maximum median | Expanded spread | Final tolerance |
| --- | ---: | ---: | ---: | ---: |
| `firstRowsMs` | 116.4000 | 180.0000 | 54.6392% | 25% |
| `jumpMs` | 82.5000 | 97.6000 | 18.3030% | 25% |
| `indexedSortMs` | 111.1000 | 196.6000 | 76.9577% | 25% |
| `scrollingFps` | 59.8038 | 60.0026 | 0.3323% | 5% |
| `frameP95Ms` | 16.7000 | 16.7000 | 0.0000% | 5% |
| `localEchoMs` | 5.1001 | 8.3000 | 62.7429% | 25% |
| `acknowledgmentP95Ms` | 34.5000 | 64.5499 | 87.1012% | 25% |
| `peerP95Ms` | 32.1998 | 57.7500 | 79.3488% | 25% |
| `shellGzipBytes` | 234060.0000 | 234060.0000 | 0.0000% | 5% |
| `cls` | 0.0000 | 0.0000 | 0.0000% | 5% |

## Validation of the revised comparison

The required build, lint, typecheck, unit tests, catalog extraction, and settings checks passed with
the revised tolerances.  The server passed 5,185 tests, and the web passed 4,260 tests, including all
14 performance-report tests.  The new regression cases fail when each latency metric is 30% slower
than all five passing reports on a quiet machine.

A separate full performance run passed all 15 Chromium tests in 4.1 minutes.  Its report at
`2026-10-10T20:38:08.213Z` contained no failures.  The 103 measurement boundaries recorded one-minute
load readings from 9.3999 to 15.3564 against a limit of 13.5, so regression comparison was skipped.
Every absolute budget passed.  No other build or test job from this validation session ran beside
the performance suite.  The figures below are rounded to four decimal places, while the report
retains every raw sample.

| Metric | Median | Budget statistic | Samples |
| --- | ---: | ---: | ---: |
| `firstRowsMs` | 197.1000 | 229.4000 | 5 |
| `jumpMs` | 104.2000 | 118.3000 | 5 |
| `indexedSortMs` | 204.8000 | 295.0000 | 5 |
| `scrollingFps` | 60.0020 | 59.8027 | 10 |
| `frameP95Ms` | 16.7000 | 16.7000 | 3008 |
| `localEchoMs` | 8.9500 | 12.6001 | 30 |
| `acknowledgmentP95Ms` | 67.3500 | 98.1001 | 30 |
| `peerP95Ms` | 58.9001 | 83.0002 | 30 |
| `shellGzipBytes` | 234101.0000 | 234101.0000 | 1 |
| `cls` | 0.0000 | 0.0000 | 40 |
