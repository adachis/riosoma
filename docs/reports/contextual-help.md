# Contextual help coverage

Help chooses a focused documented control first, an open configuration surface second, the active non-grid view type third, the current route fourth, and visible page anchors fifth.  Grid views keep their editing overview.  Module order and IDs break ties.  Other matches appear under Also about this screen, and an unmatched screen opens All topics.

The documentation window stores its preferred desktop position and size in browser storage, separately from the bounds fitted to the current viewport.  Opening it on a phone or in a smaller browser preserves those desktop preferences.  Its module, section, and window state use the existing help search parameters.  Moving and resizing write preferences when a gesture ends.  Resizing the browser keeps the window in view, and a phone uses a full-screen sheet.

## Review fixes

The active view type is captured even when its settings are closed.  Visible view settings anchors provide a fallback when that marker is unavailable.  Form documentation outranks the generic database route, while focused controls and open configuration surfaces retain their priority.

An external section request exits search even when it stays in the selected module or repeats the current section.  Repeated requests also restore the section's focus and scroll position.  A dialog named by its title receives its configured help button without changing its accessible name.  Opening the documentation window in a phone or a smaller desktop viewport preserves its saved desktop geometry in memory and storage.

Regression tests reproduced all four findings before the fixes.  Context tests use every shipped module and cover the form anchor fallback, closed map settings, grid editing, focused fields, and open filters.  Window component tests cover opening at phone and smaller desktop sizes before expanding the viewport.

## Coverage

The anchor report finds 183 registered anchors and 180 documented anchors.  No module refers to a retired anchor.  The existing source coverage test also checks that registered anchors are mounted by the interface.

The following anchors have no module and are reported without failing verification:

- `view.filter.add`
- `view.group.add`
- `view.sort.add`

The Integrations settings page has no documentation section for its cloud drive administration and payment configuration.  It opens All topics and has no section button until that documentation exists.

Run `node tools/help-coverage.mjs` to produce the current JSON coverage report.

## Validation

The final documentation checks passed 32 tests across six files.  The dashboard keyboard and layout file passed all nine tests after including the new help button alongside every existing control in its keyboard order.  The initial unit also verified read-only help, forms, color editors, and settings mappings.  The four review regressions and the repeated-section search regression failed before their fixes and passed afterward.

The first screen transfers 249,904 gzipped bytes against its 250,000-byte budget.  Help content and contextual ranking load on demand.

The browser checks cover five screens, form views, sharing help, four other section buttons, preserved field drafts, window gestures, keyboard navigation, search, history, viewport bounds, reload, and docking at desktop and phone widths.  The browser fixture scans accessibility at each state.  All 18 contextual checks passed across Chromium, Firefox, and WebKit at both widths, including corrected phone view-picker interactions.  The final six-check run also passed repeated-section requests after moving the documentation window clear of the page controls.  Seven existing help, command palette, and public form checks passed in Chromium.

The full verification command passed build, lint, and typecheck, then failed during tests.  The web run passed 3,969 tests and failed the old dashboard keyboard expectation and a PDF export timeout.  The corrected dashboard file and the four PDF tests passed in isolated runs.  The server cached-read benchmark failed its 50 ms median limit, measured 78.9 ms in the first isolated retry, and passed when retried after the larger verification tasks finished.  That test and its limit remain unchanged.

A retry with packages tested sequentially passed all 29 build, lint, and typecheck tasks, plus all six server timing groups.  It then reported failures in compound fields, SQL classification, remote tools, realtime presence, and retention archives.  The compound-field, SQL, realtime, and archive checks passed individually with unchanged assertions.  Retrying the remote-tools file alone passed 38 tests and failed nine, with 10-second setup-hook timeouts and conflict responses during setup.  The extended retry was interrupted after the server failures and timeouts to follow the brief's deadline instruction to use focused tests.  The required full verification has not passed.  Message extraction and settings validation passed separately, and extraction changes outside the English catalog were discarded to keep the unit English only.

Generated screenshots are saved under `tools/.unit-logs/contextual-help/evidence/`, and validation logs and reports are saved under `tools/.unit-logs/contextual-help/`.  Copying them to the requested persistent reference directory needs an exception to the initial file scope rule.

## Decisions

Context follows the focused control before the containing surface.  Active non-grid views precede route fallbacks, and route matches precede general page anchors so shared controls cannot replace the current screen's topic.  Window geometry is a browser preference, and documentation navigation uses deep links.  Domain data and access decisions use the existing paths.

## Changed files

- `apps/e2e/tests/k-contextual-help.spec.ts`—Verify contextual help behavior and existing controls
- `apps/web/src/demos/anchors.ts`—Register documented screen and configuration anchors
- `apps/web/src/demos/scripts.test.ts`—Verify contextual help behavior and existing controls
- `apps/web/src/docs/DocView.tsx`—Provide contextual navigation and the documentation window
- `apps/web/src/docs/DocsPanel.test.tsx`—Verify contextual help behavior and existing controls
- `apps/web/src/docs/DocsPanel.tsx`—Provide contextual navigation and the documentation window
- `apps/web/src/docs/DocsWindow.tsx`—Provide contextual navigation and the documentation window
- `apps/web/src/docs/DocsWindow.test.tsx`—Preserve saved desktop geometry when opening at smaller viewport sizes
- `apps/web/src/docs/HelpButton.tsx`—Provide contextual navigation and the documentation window
- `apps/web/src/docs/HelpDialogTitle.tsx`—Provide contextual navigation and the documentation window
- `apps/web/src/docs/context.test.ts`—Verify contextual help behavior and existing controls
- `apps/web/src/docs/context.ts`—Provide contextual navigation and the documentation window
- `apps/web/src/docs/coverage.test.ts`—Verify contextual help behavior and existing controls
- `apps/web/src/docs/docs.css`—Provide contextual navigation and the documentation window
- `apps/web/src/docs/help-button.css`—Provide contextual navigation and the documentation window
- `apps/web/src/docs/help-request.ts`—Provide contextual navigation and the documentation window
- `apps/web/src/docs/screen-context.ts`—Provide contextual navigation and the documentation window
- `apps/web/src/docs/settings-help.ts`—Provide contextual navigation and the documentation window
- `apps/web/src/docs/view-help.ts`—Provide contextual navigation and the documentation window
- `apps/web/src/docs/window-position.test.ts`—Verify contextual help behavior and existing controls
- `apps/web/src/docs/window-position.ts`—Provide contextual navigation and the documentation window
- `apps/web/src/features/ai/AiSettings.tsx`—Mount documented anchors on their controls
- `apps/web/src/features/ai/Knowledge.tsx`—Mount documented anchors on their controls
- `apps/web/src/features/ai/Libraries.tsx`—Mount documented anchors on their controls
- `apps/web/src/features/ai/RemoteTools.tsx`—Mount documented anchors on their controls
- `apps/web/src/features/rio/Blocks.tsx`—Mount documented anchors on their controls
- `apps/web/src/locales/en-US/messages.po`—Add English help labels
- `apps/web/src/router.tsx`—Validate module, section, and window deep links
- `apps/web/src/screens/SignInScreen.tsx`—Mount documented anchors on their controls
- `apps/web/src/screens/database/DatabaseScreen.tsx`—Expose section help on documented configuration surfaces
- `apps/web/src/screens/database/automations/AutomationScreen.tsx`—Expose section help on documented configuration surfaces
- `apps/web/src/screens/database/automations/Card.tsx`—Expose section help on documented configuration surfaces
- `apps/web/src/screens/database/automations/StepCard.tsx`—Expose section help on documented configuration surfaces
- `apps/web/src/screens/database/dashboards/DashboardScreen.tsx`—Expose section help on documented configuration surfaces
- `apps/web/src/screens/database/dashboards/DashboardGrid.test.tsx`—Check the new help button and every existing dashboard control in keyboard order
- `apps/web/src/screens/database/fields/FieldDialog.tsx`—Expose section help on documented configuration surfaces
- `apps/web/src/screens/database/interfaces/InterfaceScreen.tsx`—Expose section help on documented configuration surfaces
- `apps/web/src/screens/database/joins/TableDataControls.tsx`—Expose section help on documented configuration surfaces
- `apps/web/src/screens/database/share-view/ShareViewDialog.tsx`—Expose section help on documented configuration surfaces
- `apps/web/src/screens/database/share/ShareDialog.tsx`—Expose section help on documented configuration surfaces
- `apps/web/src/screens/database/synced/SyncWizard.tsx`—Expose section help on documented configuration surfaces
- `apps/web/src/screens/database/view/OfficeDownloadDialog.tsx`—Expose section help on documented configuration surfaces
- `apps/web/src/screens/database/view/ToolbarSettings.test.tsx`—Verify contextual help behavior and existing controls
- `apps/web/src/screens/database/view/ToolbarSettings.tsx`—Expose section help on documented configuration surfaces
- `apps/web/src/screens/database/view/ViewToolbar.tsx`—Expose section help on documented configuration surfaces
- `apps/web/src/screens/database/view/view.test.tsx`—Verify contextual help behavior and existing controls
- `apps/web/src/screens/database/views/form/PublicFormShare.tsx`—Expose section help on documented configuration surfaces
- `apps/web/src/screens/database/views/form/index.tsx`—Expose section help on documented configuration surfaces
- `apps/web/src/screens/database/views/summary/FilterControl.tsx`—Expose section help on documented configuration surfaces
- `apps/web/src/screens/import/ImportDialog.tsx`—Expose section help on documented configuration surfaces
- `apps/web/src/screens/import/ImportIntoTable.tsx`—Expose section help on documented configuration surfaces
- `apps/web/src/screens/oauth/OAuthConsentScreen.tsx`—Mount documented anchors on their controls
- `apps/web/src/screens/settings/SettingsScreen.tsx`—Expose section help on documented configuration surfaces
- `apps/web/src/screens/settings/oauth/OAuthApps.tsx`—Mount documented anchors on their controls
- `apps/web/src/screens/settings/sources/DriversSettings.tsx`—Mount documented anchors on their controls
- `apps/web/src/screens/settings/sources/SourceDialog.tsx`—Expose section help on documented configuration surfaces
- `apps/web/src/screens/settings/sources/SourcesSettings.tsx`—Mount documented anchors on their controls
- `apps/web/src/screens/setup/DatabaseStep.tsx`—Mount documented anchors on their controls
- `apps/web/src/screens/setup/OwnerStep.tsx`—Mount documented anchors on their controls
- `apps/web/src/shell/AppShell.tsx`—Open contextual help and preserve documentation while navigating
- `apps/web/src/shortcuts/registry.ts`—Open contextual help with F1
- `apps/web/src/shortcuts/runtime.ts`—Open contextual help with F1
- `docs/modules/account/connected-accounts/en-US.md`—Declare contextual anchors, sections, and routes
- `docs/modules/account/notifications/en-US.md`—Declare contextual anchors, sections, and routes
- `docs/modules/account/passkeys-and-two-step-sign-in/en-US.md`—Declare contextual anchors, sections, and routes
- `docs/modules/account/profile/en-US.md`—Declare contextual anchors, sections, and routes
- `docs/modules/administration/admin-roles-and-audit/en-US.md`—Declare contextual anchors, sections, and routes
- `docs/modules/administration/credential-vaults/en-US.md`—Declare contextual anchors, sections, and routes
- `docs/modules/administration/custom-domains/en-US.md`—Declare contextual anchors, sections, and routes
- `docs/modules/administration/data-classification/en-US.md`—Declare contextual anchors, sections, and routes
- `docs/modules/administration/export-and-import/en-US.md`—Declare contextual anchors, sections, and routes
- `docs/modules/administration/file-uploads/en-US.md`—Declare contextual anchors, sections, and routes
- `docs/modules/administration/mcp/en-US.md`—Declare contextual anchors, sections, and routes
- `docs/modules/administration/oauth-apps/en-US.md`—Declare contextual anchors, sections, and routes
- `docs/modules/administration/org-units/en-US.md`—Declare contextual anchors, sections, and routes
- `docs/modules/administration/organization-logo/en-US.md`—Declare contextual anchors, sections, and routes
- `docs/modules/administration/people-roles-and-lifecycle/en-US.md`—Declare contextual anchors, sections, and routes
- `docs/modules/administration/rest-api/en-US.md`—Declare contextual anchors, sections, and routes
- `docs/modules/administration/retention/en-US.md`—Declare contextual anchors, sections, and routes
- `docs/modules/administration/scim-provisioning/en-US.md`—Declare contextual anchors, sections, and routes
- `docs/modules/administration/sign-in-policy/en-US.md`—Declare contextual anchors, sections, and routes
- `docs/modules/administration/single-sign-on/en-US.md`—Declare contextual anchors, sections, and routes
- `docs/modules/administration/telemetry/en-US.md`—Declare contextual anchors, sections, and routes
- `docs/modules/administration/updates/en-US.md`—Declare contextual anchors, sections, and routes
- `docs/modules/appearance/language/en-US.md`—Declare contextual anchors, sections, and routes
- `docs/modules/appearance/themes/en-US.md`—Declare contextual anchors, sections, and routes
- `docs/modules/data-sources/drivers/en-US.md`—Declare contextual anchors, sections, and routes
- `docs/modules/data-sources/joined-tables/en-US.md`—Declare contextual anchors, sections, and routes
- `docs/modules/databases/automations/en-US.md`—Declare contextual anchors, sections, and routes
- `docs/modules/databases/calendar/en-US.md`—Declare contextual anchors, sections, and routes
- `docs/modules/databases/charts-and-pivot-tables/en-US.md`—Declare contextual anchors, sections, and routes
- `docs/modules/databases/conditional-colors/en-US.md`—Declare contextual anchors, sections, and routes
- `docs/modules/databases/dashboards/en-US.md`—Declare contextual anchors, sections, and routes
- `docs/modules/databases/downloading/en-US.md`—Declare contextual anchors, sections, and routes
- `docs/modules/databases/editing/en-US.md`—Declare contextual anchors, sections, and routes
- `docs/modules/databases/fields/en-US.md`—Declare contextual anchors, sections, and routes
- `docs/modules/databases/forms/en-US.md`—Declare contextual anchors, sections, and routes
- `docs/modules/databases/formulas/en-US.md`—Declare contextual anchors, sections, and routes
- `docs/modules/databases/gallery/en-US.md`—Declare contextual anchors, sections, and routes
- `docs/modules/databases/importing/en-US.md`—Declare contextual anchors, sections, and routes
- `docs/modules/databases/interfaces/en-US.md`—Declare contextual anchors, sections, and routes
- `docs/modules/databases/kanban/en-US.md`—Declare contextual anchors, sections, and routes
- `docs/modules/databases/list-and-map/en-US.md`—Declare contextual anchors, sections, and routes
- `docs/modules/databases/public-view-links/en-US.md`—Declare contextual anchors, sections, and routes
- `docs/modules/databases/scheduled-reports/en-US.md`—Declare contextual anchors, sections, and routes
- `docs/modules/databases/sharing/en-US.md`—Declare contextual anchors, sections, and routes
- `docs/modules/databases/snapshots-and-copies/en-US.md`—Declare contextual anchors, sections, and routes
- `docs/modules/databases/synced-tables/en-US.md`—Declare contextual anchors, sections, and routes
- `docs/modules/databases/timeline-and-gantt/en-US.md`—Declare contextual anchors, sections, and routes
- `docs/modules/databases/views/en-US.md`—Declare contextual anchors, sections, and routes
- `docs/modules/getting-started/feedback/en-US.md`—Declare contextual anchors, sections, and routes
- `docs/modules/getting-started/welcome/en-US.md`—Declare contextual anchors, sections, and routes
- `docs/modules/personal/celebrations-and-sounds/en-US.md`—Declare contextual anchors, sections, and routes
- `docs/modules/personal/levels/en-US.md`—Declare contextual anchors, sections, and routes
- `docs/modules/rio/asking-rio/en-US.md`—Declare contextual anchors, sections, and routes
- `docs/modules/rio/cloud-providers/en-US.md`—Declare contextual anchors, sections, and routes
- `docs/modules/rio/knowledge-libraries/en-US.md`—Declare contextual anchors, sections, and routes
- `docs/modules/rio/memory/en-US.md`—Declare contextual anchors, sections, and routes
- `docs/modules/rio/routines/en-US.md`—Declare contextual anchors, sections, and routes
- `docs/reports/contextual-help.md`—Record coverage, decisions, validation, and changed files
- `packages/contracts/src/docs.ts`—Declare section and route metadata for help modules
- `tools/help-coverage.mjs`—Report missing and undocumented anchors
