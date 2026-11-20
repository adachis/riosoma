# @riosoma/ui

Shared components, built on React Aria Components and styled only with the `--rio-*` variables, so every one of them works in all 52 themes and their color schemes.

## Conventions

- **One component per file**, `Name.tsx`, with its styles in `Name.css` imported at the top of the component.  All rules sit inside `@layer rio.components { … }` and use the `rio-` class prefix (`.rio-button`, `.rio-button__spinner`).
- **Style state through React Aria's data attributes**: `[data-hovered]`, `[data-pressed]`, `[data-focus-visible]`, `[data-disabled]`, `[data-selected]`, `[data-invalid]`, and so on.  Variants and sizes are `data-variant` and `data-size`.
- **Colors, fonts, and radius come from the theme** (`--rio-bg`, `--rio-surface`, `--rio-text`, `--rio-text-muted`, `--rio-border`, `--rio-accent`, `--rio-on-accent`, `--rio-link`, `--rio-focus`, `--rio-success`, `--rio-warning`, `--rio-danger`, `--rio-info`, `--rio-font-body`, `--rio-font-display`, `--rio-font-mono`, `--rio-radius`).  Spacing, sizes, motion, and layering come from `@riosoma/tokens/base.css` (`--rio-space-*`, `--rio-text-*`, `--rio-control-height*`, `--rio-target-*`, `--rio-duration-*`, `--rio-ease-*`, `--rio-z-*`, `--rio-hover`, `--rio-pressed`, `--rio-selected`, `--rio-focus-ring`, `--rio-shadow-*`).  Never use a theme's own variables or hard-coded colors.
- **Legibility comes from the `--rio-aa-*` tier** wherever text or a boundary must be readable: `--rio-aa-on-accent` for text on an accent fill, `--rio-aa-text-muted` for secondary text, `--rio-aa-link`, `--rio-aa-focus` (already inside `--rio-focus-ring`), `--rio-aa-border` for control outlines, and `--rio-aa-<status>-text` or `--rio-aa-on-<status>` for status colors.  Each meets WCAG AA in every theme and scheme.  Plain `--rio-*` colors are for fills and decoration.
- **Logical properties only** (`inline-size`, `margin-inline`, `inset-inline-start`), so right-to-left languages work.
- **Targets** are at least `--rio-target-min` (24px, WCAG 2.2's minimum target size) on each side.  A screen's primary actions are at least `--rio-target-primary`, which is 44px on phones and the minimum everywhere else, so desktop layouts stay compact.  Buttons count as primary with `variant="primary"`, with `primaryAction`, or in a dialog's footer, and so do the rows of a menu or a list box.  Size them through these variables, never per screen.
- **Nothing changes size at runtime.**  States swap colors and visibility, never dimensions, and nothing moves under the pointer.
- **Motion** uses the duration and easing tokens, which drop to zero for reduced motion.  Support `forced-colors: active`.
- **Text** that the component itself shows (a Close label, a loading announcement) uses Lingui macros with an explicit key and American English source text: `t({ id: 'ui.dialog.close', message: 'Close' })`.  Labels passed in by callers are already translated.
- **Icons** come from `@riosoma/icons` (`<Icon icon={faXmark} />`) with icon definitions imported by name from `@fortawesome/free-solid-svg-icons` or `@fortawesome/free-regular-svg-icons`.
- **Never a native browser dialog** (`alert`, `confirm`, `prompt`).

## Every component ships with

1. `Name.test.tsx`: behavior through the accessibility tree (`getByRole`), keyboard use, and states.
2. `Name.gallery.tsx`: an exported `gallery: GalleryEntry` showing every variant and state.  The app's gallery page renders all of them in every theme for visual checks.  Sample labels there can be plain text.
3. An export from `src/index.ts`.

`Button` is the reference implementation.
