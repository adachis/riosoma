"""The Riosoma semantic layer: one set of --rio-* variables that every theme maps onto its own tokens.

Riosoma's components style themselves with --rio-* only, so they work under any theme and scheme.
build_themes.py appends the mapping to each theme.css and records it in theme.json.
"""
import re

# Each token lists candidate source names in priority order.  A candidate matches a theme variable
# exactly or after the theme's own prefix (--k-bg matches "bg" in Kicks).  Element hints (what the
# theme's own body, h1, code, and a rules use) outrank the lists.  tools/theme_config.json can
# override any token per theme under "semantic".
TOKENS = {
    'bg': ('color', 'body-bg', ['bg-page', 'surface-page', 'page-bg', 'ground-page', 'bg-app', 'bg-base', 'bg',
                                'background', 'paper', 'surface-paper', 'ground', 'canvas-0', 'surface', 'window-bg']),
    'surface': ('color', None, ['surface-card', 'card', 'card-bg', 'bg-card', 'surface-raised', 'surface-1', 'bg-panel',
                                'surface-panel', 'panel', 'bg-surface', 'bg-raised', 'window-bg', 'surface-2', 'paper-1',
                                'paper-2', 'surface']),
    'text': ('color', 'body-color', ['text-body', 'text-primary', 'text', 'fg-1', 'fg', 'text-1', 'ink', 'body-text',
                                     'window-text']),
    'text-muted': ('color', None, ['text-muted', 'text-secondary', 'muted', 'fg-2', 'text-2', 'fg-muted', 'text-dim',
                                   'text-soft', 'ink-soft', 'ink-muted', 'ink-dim', 'ink-2', 'dim', 'text-faint']),
    'border': ('color', None, ['border', 'border-subtle', 'border-default', 'border-color', 'line', 'line-2', 'rule',
                               'rule-color', 'hairline', 'border-hairline', 'edge-hairline', 'border-soft', 'window-border',
                               'stroke', 'stroke-1', 'line-1', 'border-strong', 'border-ink', 'outline']),
    'accent': ('color', None, ['action-primary', 'accent', 'brand', 'brand-primary', 'primary', 'accent-1', 'action',
                               'cta', 'brand-4', 'accent-primary', 'highlight', 'signal', 'p-1', 'p1']),
    'on-accent': ('color', None, ['on-accent', 'text-on-accent', 'accent-ink', 'on-brand', 'text-on-brand', 'on-primary',
                                  'accent-contrast', 'accent-fg', 'on-accent-1', 'text-on-action']),
    'link': ('color', 'a-color', ['text-link', 'link', 'fg-link', 'text-accent', 'accent-text']),
    'focus': ('color', None, ['focus', 'focus-ring', 'line-focus', 'ring', 'focus-color', 'accent-focus']),
    'success': ('color', None, ['status-good', 'success', 'status-success', 'state-success', 'status-positive',
                                'state-positive', 'feedback-success', 'signal-ok', 'state-ok', 'ok', 'ok-500', 'ok-3',
                                'good', 'positive', 'status-ok', 'go']),
    'warning': ('color', None, ['status-warn', 'warning', 'warn', 'status-warning', 'state-warning', 'status-caution',
                                'state-caution', 'feedback-warning', 'signal-warn', 'state-warn', 'warn-500', 'warn-3',
                                'caution']),
    'danger': ('color', None, ['status-bad', 'danger', 'error', 'status-danger', 'status-error', 'state-danger',
                               'status-critical', 'state-critical', 'feedback-danger', 'status-neg', 'danger-500',
                               'signal-alert', 'alert-3', 'err', 'bad', 'negative', 'critical']),
    'info': ('color', None, ['status-info', 'info', 'state-info', 'feedback-info', 'signal-info', 'info-500', 'info-3',
                             'notice']),
    'font-body': ('font', 'body-font', ['font-body', 'font-text', 'font-sans', 'font-ui', 'font-core', 'type-ui-family',
                                        'font-copy', 'font']),
    'font-display': ('font', 'h1-font', ['font-display', 'font-heading', 'font-headline', 'font-title', 'font-slab',
                                         'font-serif']),
    'font-mono': ('font', 'code-font', ['font-mono', 'font-code', 'font-annotate', 'mono']),
    'radius': ('length', None, ['radius', 'radius-md', 'radius-control', 'r-md', 'radius-m', 'radius-2', 'corner']),
}
# When a theme has nothing that fits, fall back to another --rio-* token so every variable always resolves.
FALLBACKS = {'surface': 'bg', 'text-muted': 'text', 'border': 'text', 'on-accent': 'bg', 'link': 'accent',
             'focus': 'accent', 'font-display': 'font-body', 'info': 'accent'}
# Status colors a theme doesn't define fall back to plain, legible defaults.
LITERAL_FALLBACKS = {'font-body': 'system-ui, sans-serif', 'font-mono': 'ui-monospace, monospace', 'radius': '0px',
                     'success': '#2f9e56', 'warning': '#c77700', 'danger': '#d92d20'}
# Variable prefixes that some systems put on every token (Kicks uses --k-bg, Glitch --gl-bg, and so on).
PREFIXES = ['k-', 'gl-', 'gf-', 'gv-', 'bp-', 'nb-', 'nt-', 's7-', 'neu-', 'ds-']
ELEMENT_RULES = {  # hint name: (selectors, property)
    'body-bg': (('html', 'body'), ('background', 'background-color')),
    'body-color': (('html', 'body'), ('color',)),
    'body-font': (('html', 'body'), ('font-family',)),
    'h1-font': (('h1',), ('font-family',)),
    'code-font': (('code', 'pre', 'kbd'), ('font-family',)),
    'a-color': (('a', 'a:link'), ('color',)),
}


def system_prefixes(names):
    """The known prefixes this theme actually uses."""
    return [p for p in PREFIXES if sum(n.startswith('--' + p) for n in names) >= 5]


COLORISH = re.compile(r'^(#[0-9a-f]{3,8}|(rgb|hsl|hwb|lab|lch|oklab|oklch|color|color-mix|light-dark)\(|var\(--[\w-]+\)$|'
                      r'transparent$|currentcolor$|[a-z]+$)', re.I)
LENGTHISH = re.compile(r'^(0|-?[\d.]+(px|rem|em|%)|var\(--[\w-]+\)|calc\()', re.I)


def fits(kind, values):
    """Whether a variable's declared values look like the kind of value the token needs."""
    if kind == 'color':
        return any(COLORISH.match(v) and not re.search(r'\b\d+(px|rem|em)\b|\bsolid\b|\binset\b', v) for v in values)
    if kind == 'length':
        return any(LENGTHISH.match(v) and ' ' not in v.strip() for v in values)
    return True


def match(candidate, values, prefixes, kind):
    for name in ['--' + candidate] + ['--' + p + candidate for p in prefixes]:
        if name in values and fits(kind, values[name]):
            return name
    return None


def resolve(values, hints, overrides, background_var=None):
    """Map every --rio-* token to one of the theme's variables, another --rio-* token, or a literal.

    values maps each variable the theme declares to the list of values it's given.
    """
    names = set(values)
    prefixes = system_prefixes(names)
    if background_var and 'bg' not in overrides:
        overrides = dict(overrides, bg=background_var)
    mapping, how = {}, {}
    for token, (kind, hint, candidates) in TOKENS.items():
        if token in overrides:
            mapping[token], how[token] = overrides[token], 'config'
            continue
        found = hints.get(hint) if hint else None
        if found and found in names and fits(kind, values[found]) and not (token == 'link' and found == hints.get('body-color')):
            mapping[token], how[token] = found, 'element rule'
            continue
        for c in candidates:
            found = match(c, values, prefixes, kind)
            if found:
                mapping[token], how[token] = found, 'name'
                break
        else:
            if token in FALLBACKS:
                mapping[token], how[token] = '--rio-' + FALLBACKS[token], 'fallback'
            elif token in LITERAL_FALLBACKS:
                mapping[token], how[token] = LITERAL_FALLBACKS[token], 'fallback'
            else:
                mapping[token], how[token] = None, 'missing'
    return mapping, how


def css_block(mapping):
    """The --rio-* declarations.  They're pure aliases, so any element that changes the scheme, mode,
    or surface re-declares them and they resolve against that element's own values."""
    lines = []
    for token, src in mapping.items():
        if src is None:
            continue
        value = f'var({src})' if src.startswith('--') else src
        if token == 'text':
            lines.append(f'  --rio-ink: {value};')
        if token in ('text', 'text-muted', 'on-accent'):
            # Screens using the semantic text tokens receive the generated legibility tier too.
            value = f'var(--rio-legible-{token}, {value})'
        lines.append(f'  --rio-{token}: {value};')
    return (':root, [data-scheme], [data-mode], [data-surface] {\n' + '\n'.join(lines) + '\n}\n')
