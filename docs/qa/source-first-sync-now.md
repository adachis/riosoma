# Source copy dispatch and progress

The regression uses a PostgreSQL source with 50,000 rows and the real cursor, staging, apply, and realtime paths.  The source pauses for three seconds after its first 5,000 rows so progress remains observable.  Its failure variant raises a source error at that point, then recovers after Retry.  Theme assets are installed for every browser run.

The baseline uses the original server and web implementation with the same browser spec.  Copy start is measured from the creation click to the running-status websocket message.  Preview and join timings include displaying the result.  Connection timing measures the connection-test request.  Record arrival is measured from creation until the grid displays a source record and the 50,000-record count.

| Step | Before, Chromium | After, Chromium |
| --- | ---: | ---: |
| Connection test | 28 ms | 30 ms |
| Preview displayed | 487 ms | 493 ms |
| Copy started | 16,784 ms | 235 ms |
| Copy progress visible | Unavailable | 263 ms |
| 50,000 records available without a reload | 23,056 ms | 6,739 ms |
| Join suggestions displayed | 1,125 ms | 1,931 ms |

The baseline's dispatch delay depends on the scheduler phase and can approach 30 seconds.  The pause is part of both workloads, so these results measure dispatch and display latency rather than an unthrottled connector benchmark.

| Browser and case | Connection | Preview | Copy started | Progress visible | Records visible | Join suggestions |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Chromium, successful first copy | 30 ms | 493 ms | 235 ms | 263 ms | 6,739 ms | 1,931 ms |
| Chromium, failed first copy and retry | 25 ms | 530 ms | 245 ms | 262 ms | 10,999 ms | 1,304 ms |
| Firefox, successful first copy | 26 ms | 2,299 ms | 797 ms | 1,446 ms | 15,622 ms | 2,585 ms |
| Firefox, failed first copy and retry | 20 ms | 2,392 ms | 969 ms | 1,532 ms | 21,092 ms | 2,020 ms |
| WebKit, successful first copy | 101 ms | 707 ms | 294 ms | 321 ms | 11,596 ms | 4,435 ms |
| WebKit, failed first copy and retry | 34 ms | 611 ms | 253 ms | 290 ms | 14,601 ms | 4,020 ms |

The failure cases run at 390 by 844 pixels with a long table name.  Their record timings include the failed attempt, the correction, and the retry.  Every case checks zero document reloads, a visible 5,000-row count, and elapsed time.  Retry also has a two-second progress assertion.  These are individual runs on a shared machine, not percentile measurements.

Progress is observed while the click helper's accessibility checks run.  Waiting for that helper to finish can miss the temporary copying state, because its checks may continue until the copy finishes.  The spec retains the accessibility checks, the visible row-count and elapsed-time assertions, and the two-second limit.  Preview, record, and join timings include the helper's verification work.

Earlier Chromium runs observed records after 7,663 ms and 12,133 ms.  They started copying after 175 ms and 246 ms, respectively.  The final measurements above keep the shared-machine variation visible rather than treating one run as a processing-time guarantee.

Connection checks and snapshot previews already use their request completion directly.  Neither polls for its result.  An open join dialog previously retained its initial result after tables became available.  It now compares again when table creation or copy completion changes the session metadata.  Webhook preview polling belongs to incoming-post discovery and is outside this snapshot flow.

Creation, Sync now, retry, and overdue schedule changes wake the worker after the command commits.  The existing database lease prevents concurrent starts across instances.  The 30-second scheduler remains the recovery path for a lost dispatch.  A busy worker remembers pending dispatches and resumes them when capacity becomes available.

Progress follows the existing authorized table-change channel.  Row counts are withheld from readers limited by record rules, and stored status stays intact.  Progress updates do not reload grid rows, notify the organization-wide home channel, or invalidate search vectors and indexing work.  Table edits, record edits, and copy completion keep their existing invalidation behavior.  Elapsed time is a local counter.  The API exposes the optional row count in table metadata, and the existing API, MCP, and Rio commands trigger the same immediate dispatch.

PostgreSQL cursor cleanup previously replaced a source read error with a secondary transaction error.  The reader now preserves the original reason.  Diagnostics that can contain row values are withheld from restricted readers through the shared permission filter.

On phones, navigation to the created table closes the sidebar drawer so copying and Retry remain reachable.  Status text wraps, controls use labeled icon buttons with tooltips, and the first copy occupies the view until records are ready.  The table's existing address opens its copying, failed, or completed state.

The worker keeps its existing limit of two concurrent copies.  Schedule changes calculate the next due time from the last successful copy, falling back to the last attempt or the current time when no success exists.  No dependency, migration, table, or command endpoint was added.

Regression tests failed against the original implementation for immediate dispatch, visible progress, stale join suggestions, unnecessary row reads, restricted progress, and preservation of the original PostgreSQL read error.  The targeted server tests pass: 41 tests across source behavior, scheduler capacity, and permission redaction.  The targeted web tests pass: 62 tests across source session updates, join suggestions, copy status, and the wizard, plus four database and shell checks.  The connector file passes its 15 configured tests.  Its existing 57 conditional tests for unconfigured database fleets remain unchanged.

The six new browser cases pass in Chromium, Firefox, and WebKit with theme assets installed.  The existing Chromium run covered `m-synced-tables`, `o-file-sources`, `qa-data-sources`, `qa-demo-path`, and `m-join-discovery`.  It finished with 20 passes and three failures.  The 500-field phone case exceeded its unchanged five-second dialog-close assertion during a concurrent build.  It passes when rerun alone with the same assertions and timeout, bringing the passing coverage to 21 cases.

The remaining two failures are the 2,000-customer and 2,200-customer demo walks.  Both stop before creating a snapshot because their helper looks for a Help button.  Help is already a menu item in the personal menu in the original implementation.  The helper and the Help control were not changed in this unit.  Those stale selectors remain unresolved.  The other demo cases pass, including copying, scrolling, and joining a 300-column source at desktop and phone widths.

The build, lint, and typecheck checks pass all 29 tasks.  Catalog extraction and the settings reference check also pass.  The source API schema was regenerated after rebuilding the server.  Only the English catalog is changed.

This report is kept under the permitted `docs/` scope so the evidence survives the worktree.  An additional copy outside the allowed file scope was not made.  Webhook preview discovery and sync-history polling are outside the snapshot creation flow and were not changed.

The review regressions failed before the publisher fix.  Starting and reporting a paused copy sent two home notices when none were expected.  The same progress updates advanced an enabled search index's generation from 5 to 7 and reset its cursor from 1 to 0 while committed records were unchanged.  The fixed publisher excludes progress-only updates from those side effects and preserves the change log and authorized table delivery.

The targeted server run passes 82 tests across source behavior, scheduler capacity, permission redaction, command publishing, and search indexing.  It checks zero home notices during progress, home notices after completion and table edits, unchanged vectors and indexing state during staging, index invalidation after completion, and progress delivered to an authorized realtime subscriber.  The targeted web run passes 63 tests, and the connector file passes its 15 configured tests.  Its 57 existing conditional tests for unconfigured database fleets remain unchanged.

The review browser run passes all 24 cases across `source-first-sync-now`, `m-synced-tables`, `o-file-sources`, and `m-join-discovery` in Chromium, Firefox, and WebKit.  Theme assets are installed.  Keyboard and touch source selection, local overrides, join discovery, first-copy progress, records without a reload, failure reasons, and Retry all pass.

| Review browser and case | Connection | Preview | Copy started | Progress visible | Records visible | Join suggestions |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Chromium, successful first copy | 21 ms | 617 ms | 424 ms | 450 ms | 10,992 ms | 1,281 ms |
| Chromium, failed first copy and retry | 30 ms | 583 ms | 224 ms | 249 ms | 16,635 ms | 1,719 ms |
| Firefox, successful first copy | 37 ms | 2,467 ms | 782 ms | 1,070 ms | 9,296 ms | 2,688 ms |
| Firefox, failed first copy and retry | 23 ms | 1,560 ms | 546 ms | 1,128 ms | 16,608 ms | 2,822 ms |
| WebKit, successful first copy | 44 ms | 694 ms | 260 ms | 300 ms | 14,741 ms | 1,611 ms |
| WebKit, failed first copy and retry | 20 ms | 627 ms | 249 ms | 297 ms | 16,546 ms | 1,820 ms |

The initial before-and-after measurements above remain the baseline comparison.  These review measurements repeat the same 50,000-row workload after suppressing progress side effects.  Every case meets the two-second progress assertion and checks zero document reloads.

The verification run also exposed an invalid experience level in the new help module.  Its `beginner` value prevented help metadata from loading.  The existing help-loader and demo-script tests failed before it was changed to the supported `simple` level, then all 24 tests passed.  The article's content, interface macros, and address remain intact.

All six existing help-browser cases also pass in Chromium, Firefox, and WebKit after the correction, including help navigation, addresses that reopen a topic, PDF downloads, and theme colors in PDFs.  Together with the 24 source-flow cases, the review passes 30 browser cases with theme assets installed.

The review verification passed all 29 build, lint, and typecheck tasks, catalog extraction, and the settings reference check.  The full test stage was stopped to correct the inherited help metadata error.  Its demo-runner timeout clears when rerun alone after the correction, with all 12 tests passing.  The million-row aggregation timing case also passes alone with its existing timeout.

Full verification remains blocked by the unchanged million-row paging benchmark's 50 ms cached-page median limit.  Isolated case runs measured 61.9 ms and 78.6 ms.  Running the complete test file alone measured 99.1 ms, with its other 15 tests passing.  This benchmark uses local records rather than source tables.  Its assertions and read implementation were not changed, and the full server and web test stage has not completed successfully in this review run.
