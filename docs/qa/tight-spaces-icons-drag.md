# Tight spaces, icons, and dragging

Folder rows now show their names at rest.  Rename, deletion, nested folder creation, and movement stay in the row's menu.  Shared sortable items use their bodies for dragging, preserve click and scroll thresholds, and expose one leading grip only when an editable control needs the pointer.

## Browser audit

The audit measures painted bounds and text line boxes.  It checks overlap within the same interaction layer, clipping without truncation, unwanted control wrapping, controls outside their containers, understood text actions, missing icon names, and missing tooltips.  Modal, popover, temporary toast, full-screen record panel, sticky timeline label, and freely positioned automation note, script panel, conversation panel, grid find, and demo card layers are measured independently.  Native scrolling and ellipsis remain intentional presentations.  A temporary root scroll lock crops content at the window edge without clipping a control inside its own container.

Closed disclosures can retain descendant geometry without painting their controls.  The helper excludes those descendants until the disclosure opens.  Named database, view, folder, conversation, and proposed object controls remain words even when a name begins with an understood action.  Partial virtualized grid rows and crop targets centered on a page edge have specific, reasoned allowances.

Every reported finding includes a selector, the related element when applicable, screen metadata, and a screenshot.  Coverage reports also persist for screens without findings.  The reasoned allowlist lives beside the helper and rejects entries without a reason.

Peer-page reports receive distinct artifact names so simultaneous scans cannot overwrite an attachment being read.  Tooltip positioning loads on hover or focus, keeping its positioning code out of the initial shell.

## Coverage

The representative regression covers the 265-pixel sidebar in the default, dark, and heavy themes, inline editing, long names, mouse movement, deletion, and undo.  Phone coverage exercises stationary holds and keyboard movement on Home, sidebar items, and sort rules.  A tall text-only dialog verifies keyboard scrolling while its footer remains visible.  Synthetic pointer events provide equivalent Firefox and WebKit paths where browser-specific input tooling is unavailable.

The broader screen matrix discovers registered settings pages, visits Home sections and every main record-view type, and measures phone, tablet, and laptop layouts in three themes.  Optional reporting from the existing accessibility fixture records the dialogs, menus, panels, and editing states exercised by the full browser suite.  Run the matrix with `RIOSOMA_LAYOUT_MATRIX=1` and collect full-suite reports with `RIOSOMA_LAYOUT_AUDIT=report`.

## Running the checks

Copy the supplied theme assets before browser tests.  The representative regression uses the default, dark, and heavy themes, the 265-pixel sidebar, phone holds, keyboard movement, and compact editors.

```sh
pnpm --filter @riosoma/e2e exec playwright test tests/qa-tight-spaces-icons-drag.spec.ts tests/tight-space-audit.spec.ts --project=chromium --workers=3
RIOSOMA_E2E_ALL_BROWSERS=1 pnpm --filter @riosoma/e2e exec playwright test tests/qa-tight-spaces-icons-drag.spec.ts tests/tight-space-audit.spec.ts --workers=3
RIOSOMA_LAYOUT_MATRIX=1 pnpm --filter @riosoma/e2e exec playwright test tests/tight-space-matrix.spec.ts --project=chromium --workers=3
RIOSOMA_LAYOUT_AUDIT=report pnpm --filter @riosoma/e2e e2e --project=chromium --workers=3
```

Set `RIOSOMA_LAYOUT_SCREENSHOTS=1` when collecting evidence to include screenshots of passing audited states.  The route matrix also saves a laptop screenshot for every route in each theme.  Save evidence outside the worktree before removing it.

Interactive controls are checked against every clipping ancestor, even when they have no text or an immediate parent wider than the clipping region.  Root scroll locks and native scrolling retain their intentional viewport cropping.

Mouse pickup uses five pixels of movement.  Touch and pen pickup use the shared 220-millisecond hold and seven-pixel tolerance.  Folder navigation allows 500 milliseconds for a double-click rename.
