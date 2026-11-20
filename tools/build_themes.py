#!/usr/bin/env python3
"""Build uniform Riosoma themes from the raw design systems in design-systems/.

Every design system becomes one Riosoma theme with the same switching contract:

  <link rel="stylesheet" href="themes/<theme>/theme.css">   one stylesheet per theme
  <html data-theme="<theme>" data-scheme="<scheme>">         color scheme, on <html> or any container
        data-mode="<mode>"                                   optional, only where theme.json lists modes
        data-surface="<surface>"                             optional, only where theme.json lists surfaces

Usage:
  python3 tools/build_themes.py               build, then verify every scheme in a headless browser
  python3 tools/build_themes.py --no-browser  build only (keeps appearance data from the last browser run)
"""
import argparse
import json
import os
import posixpath
import re
import shutil
import subprocess
import sys

import semantic
import remote_fonts
import font_policy
from urllib.parse import urlsplit

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'design-systems')
OUT = os.path.join(ROOT, 'themes')
CONFIG = os.path.join(ROOT, 'tools', 'theme_config.json')
VERIFY = os.path.join(ROOT, 'tools', 'verify_themes.cjs')

SCHEME_ATTR_RE = re.compile(r'\[\s*(data-(?:[a-z]{2}-)?(?:theme|scheme|palette|accent))(?![\w-])')
IMPORT_RE = re.compile(r'''@import\s+(?:url\(\s*(["']?)(?P<u1>.*?)\1\s*\)|(["'])(?P<u2>.*?)\3)[^;]*;''', re.S)
URL_RE = re.compile(r'url\(\s*(["\']?)([^"\')]*?)\1\s*\)')
FONT_HOSTS = remote_fonts.FONT_HOSTS
UNIFORM = ('data-scheme', 'data-mode', 'data-surface')


def import_url(m):
    return m.group('u1') if m.group('u1') is not None else m.group('u2')


def attr_re(name):
    """Match an attribute selector's name, e.g. the data-theme in [data-theme="x"] or [data-theme]."""
    return re.compile(r'\[(\s*)' + re.escape(name) + r'(?![\w-])')


def strip_comments(css):
    return re.sub(r'/\*.*?\*/', '', css, flags=re.S)


def sub_code(pattern, repl, css):
    """re.sub that leaves comments alone."""
    parts = re.split(r'(/\*.*?\*/)', css, flags=re.S)
    return ''.join(p if k % 2 else pattern.sub(repl, p) for k, p in enumerate(parts))


def split_top(text, sep=','):
    """Split on sep, ignoring separators inside parentheses, brackets, or strings."""
    parts, depth, quote, cur = [], 0, None, ''
    for ch in text:
        if quote:
            quote = None if ch == quote else quote
        elif ch in '"\'':
            quote = ch
        elif ch in '([':
            depth += 1
        elif ch in ')]':
            depth -= 1
        elif ch == sep and depth == 0:
            parts.append(cur)
            cur = ''
            continue
        cur += ch
    parts.append(cur)
    return parts


def block_body(css, i):
    """The text between the '{' at index i and its matching '}'."""
    depth, j, n = 0, i, len(css)
    while j < n:
        if css.startswith('/*', j):
            k = css.find('*/', j + 2)
            j = n if k < 0 else k + 2
            continue
        ch = css[j]
        if ch in '"\'':
            k = j + 1
            while k < n and css[k] != ch:
                k += 2 if css[k] == '\\' else 1
            j = k + 1
            continue
        if ch == '{':
            depth += 1
        elif ch == '}':
            depth -= 1
            if depth == 0:
                return css[i + 1:j]
        j += 1
    return css[i + 1:]


def map_preludes(css, fn, with_body=False, whole_rule=False):
    """Call fn on every rule prelude (the text before a '{') and splice in its result.

    Skips comments, strings, and url(...) so braces and semicolons inside them don't count.
    With with_body, fn also receives the rule's body text.  With whole_rule,
    fn replaces the entire rule and handles recursion itself.
    """
    out, n, i, start, emitted = [], len(css), 0, 0, 0
    while i < n:
        if css.startswith('/*', i):
            j = css.find('*/', i + 2)
            i = n if j < 0 else j + 2
            continue
        ch = css[i]
        if ch in '"\'':
            j = i + 1
            while j < n and css[j] != ch:
                j += 2 if css[j] == '\\' else 1
            i = j + 1
            continue
        if css[i:i + 4].lower() == 'url(':
            j = i + 4
            while j < n and css[j].isspace():
                j += 1
            if j < n and css[j] in '"\'':
                q = css[j]
                j += 1
                while j < n and css[j] != q:
                    j += 2 if css[j] == '\\' else 1
            k = css.find(')', j)
            i = n if k < 0 else k + 1
            continue
        if ch == '{':
            out.append(css[emitted:start])
            body = block_body(css, i) if with_body else None
            replacement = fn(css[start:i], body) if with_body else fn(css[start:i])
            if replacement is None or whole_rule:
                if replacement is not None:
                    out.append(replacement)
                i += len(body) + 2
                emitted = start = i
                continue
            out.append(replacement)
            out.append('{')
            emitted = start = i + 1
        elif ch in ';}':
            start = i + 1
        i += 1
    out.append(css[emitted:])
    return ''.join(out)


def selector_compounds(selector):
    """Separate combinators without splitting attributes or functional selectors."""
    parts, start, depth, quote, escaped = [], 0, 0, None, False
    for i, ch in enumerate(selector):
        if escaped:
            escaped = False
        elif ch == '\\':
            escaped = True
        elif quote:
            if ch == quote:
                quote = None
        elif ch in '\"\'':
            quote = ch
        elif ch in '([':
            depth += 1
        elif ch in ')]':
            depth -= 1
        elif depth == 0 and (ch.isspace() or ch in '>+~'):
            if start < i:
                parts.append(selector[start:i])
            if ch in '>+~':
                parts.append(ch)
            start = i + 1
    if start < len(selector):
        parts.append(selector[start:])
    return parts


def prose_selector(selector):
    """Constrain an element target, preserving opt-in theme class selectors."""
    parts = selector_compounds(selector)
    # An explicit component class opts into its theme, including its child rules.
    # Class names in attribute values or negations do not opt into a component.
    simple = re.sub(r'\[[^\]]*\]|\([^()]*(?:\([^()]*\)[^()]*)*\)', '', selector)
    if re.search(r'[.#][\w-]', simple):
        return selector

    qualifiers, mapped = [], []
    for part in parts:
        qualifier = re.fullmatch(r'(?:html|body|:root)?((?:\[data-(?:scheme|mode|surface)(?:[^\]]*)\])+)(::[\w-]+)?', part)
        if qualifier:
            value = qualifier.group(1)
            qualifiers.append(f':is({value}, {value} *)')
            if part == parts[-1]:
                mapped.append(':where(.rio-prose)' + (qualifier.group(2) or ''))
        else:
            mapped.append(re.sub(r'^(?:html|body|:root)(?![\w-])', ':where(.rio-prose)', part))
    # Page ancestors collapse onto the same prose container.
    while len(mapped) > 1 and mapped[0] == ':where(.rio-prose)' and mapped[1] == ':where(.rio-prose)':
        mapped.pop(0)
    target = mapped[-1]
    pseudo = re.search(r'::|:(?:before|after|first-line|first-letter)\b', target)
    offset = pseudo.start() if pseudo else len(target)
    scope = '' if ':where(.rio-prose)' in target else ':where(.rio-prose, .rio-prose *)'
    mapped[-1] = target[:offset] + ''.join(qualifiers) + scope + target[offset:]
    return ' '.join(mapped)


def scope_prose(css):
    """Keep variables global while restricting ordinary element styles to prose."""
    def rule(prelude, body):
        lead, selector, trail = selector_parts(prelude)
        if selector.startswith('@'):
            if re.match(r'@(?:media|supports|container|layer|starting-style)\b', selector):
                body = scope_prose(body)
            return prelude + '{' + body + '}'
        items = [s.strip() for s in split_top(selector)]
        scoped_items = [prose_selector(s) for s in items]
        if scoped_items == items:
            return prelude + '{' + body + '}'
        scoped = ', '.join(scoped_items)
        declarations = [d for d in split_top(strip_comments(body), ';') if d.strip()]
        global_decls = [d for d in declarations if ROOT_ONLY_OK.match(d)]
        if len(global_decls) == len(declarations):
            return prelude + '{' + body + '}'
        if not global_decls:
            return lead + scoped + trail + '{' + body + '}'
        styles = [d for d in declarations if not ROOT_ONLY_OK.match(d)]
        def declarations_block(decls):
            return '{\n' + ''.join('  ' + d.strip() + ';\n' for d in decls) + '}'
        return prelude + declarations_block(global_decls) + '\n' + scoped + trail + declarations_block(styles)
    return map_preludes(css, rule, with_body=True, whole_rule=True)


def selector_parts(prelude):
    """Split a prelude into (leading whitespace and comments, selector, trailing whitespace)."""
    m = re.match(r'(\s*(?:/\*.*?\*/\s*)*)(.*?)(\s*)$', prelude, re.S)
    return m.group(1), m.group(2), m.group(3)


def rewrite_root_items(css, replace):
    """Replace every plain ':root' item in selector lists with replace(':root')."""
    def fn(prelude):
        lead, sel, trail = selector_parts(prelude)
        if not sel or sel.startswith('@'):
            return prelude
        items = split_top(sel)
        if not any(it.strip() == ':root' for it in items):
            return prelude
        items = [(' ' if k else '') + replace(':root') if it.strip() == ':root' else it
                 for k, it in enumerate(items)]
        return lead + ','.join(items) + trail
    return map_preludes(css, fn)


ROOT_ONLY_OK = re.compile(r'^\s*(?:--[\w-]+|color-scheme)\s*:')


def apply_contract(css, default_id, default_has_block):
    """Make every scheme resolve the same way on <html> and on any nested container.

    - Plain :root rules that only set custom properties also match [data-scheme], so an element
      that sets a scheme re-derives every :root alias from its own values, exactly as <html> does.
    - When the default scheme has its own block, that block (and any [data-scheme] presence rule)
      also applies to an untagged <html>, so "no data-scheme" and data-scheme="<default>" can't drift apart.
    - A scheme rule written only for html[data-scheme="x"] also matches nested [data-scheme="x"].
    """
    default_sel = re.compile(r'^(html|:root)?\[data-scheme\s*=\s*["\']?' + re.escape(default_id) + r'["\']?\](.*)$', re.S)

    def fn(prelude, body):
        lead, sel, trail = selector_parts(prelude)
        if not sel or sel.startswith('@'):
            return prelude
        items = split_top(sel)
        stripped = [it.strip() for it in items]
        extra = []
        if ':root' in stripped and '[data-scheme]' not in stripped:
            decls = [d for d in split_top(strip_comments(body), ';') if d.strip()]
            if decls and all(ROOT_ONLY_OK.match(d) for d in decls):
                extra.append('[data-scheme]')
        for it in stripped:
            # Presence rules ([data-scheme] with no value) apply to every tagged element, so they
            # also apply to an untagged <html>, which is the default scheme.
            m = re.match(r'^\[data-scheme\](.*)$', it, re.S)
            if m and not (m.group(1) == '' and ':root' in stripped):
                clone = ':root:where(:not([data-scheme]))' + m.group(1)
                if clone not in stripped and clone not in extra:
                    extra.append(clone)
            # A scheme rule written for <html> only also applies to nested containers.
            m = re.match(r'^(?:html|:root)(\[data-scheme\s*=[^\]]+\].*)$', it, re.S)
            if m and m.group(1) not in stripped and m.group(1) not in extra:
                extra.append(m.group(1))
            # A root mode has two class-level selectors. Keep that specificity on
            # nested scheme containers so later scheme rules cannot override the mode.
            m = re.match(r'^:root(\[data-mode\s*=[^\]]+\].*)$', it, re.S)
            if m:
                clone = '[data-scheme]' + m.group(1)
                if clone not in stripped and clone not in extra:
                    extra.append(clone)
        if default_has_block:
            for it in stripped:
                m = default_sel.match(it)
                if m and not (m.group(2) == '' and ':root' in stripped):
                    clone = (m.group(1) or ':root') + ':where(:not([data-scheme]))' + m.group(2)
                    if clone not in stripped:
                        extra.append(clone)
        if not extra:
            return prelude
        return lead + sel + ''.join(', ' + e for e in extra) + trail
    return map_preludes(css, fn, with_body=True)


def element_hints(css):
    """Which variables the theme's own html, body, h1, code, and a rules use."""
    hints = {}

    def fn(prelude, body):
        _, sel, _ = selector_parts(prelude)
        if not sel or sel.startswith('@'):
            return prelude
        items = [i.strip() for i in split_top(sel)]
        for decl in split_top(strip_comments(body), ';'):
            m = re.match(r'\s*([\w-]+)\s*:\s*(.*)', decl, re.S)
            refs = re.findall(r'var\((--[\w-]+)', m.group(2)) if m else []
            for hint, (selectors, props) in semantic.ELEMENT_RULES.items():
                if refs and hint not in hints and m.group(1) in props and any(i in selectors for i in items):
                    hints[hint] = refs[0]
        return prelude
    map_preludes(css, fn, with_body=True)
    return hints


def read_tsv(path):
    lines = open(path, encoding='utf-8').read().splitlines()
    head = lines[0].split('\t')
    return [dict(zip(head, line.split('\t'))) for line in lines[1:] if line]


def titlecase(scheme_id):
    return ' '.join(w.capitalize() for w in scheme_id.split('-'))


def clean_name(name, scheme_id):
    """A display name: the source's own label when it has one, tidied, or the id in title case."""
    name = re.sub(r'\s*\(default\)\s*$', '', name or '').strip()
    if not name:
        return titlecase(scheme_id)
    if name.islower() or name.isupper():
        return ' '.join(w.capitalize() for w in re.split(r'[\s-]+', name))
    return name


def norm(text):
    return re.sub(r'[^a-z0-9]', '', text.lower().replace('&', 'and'))


def load_order(slug):
    """Token files in the order the system's own styles.css imports them, plus external font imports."""
    styles = open(os.path.join(SRC, slug, 'styles.css'), encoding='utf-8').read()
    tokens, fonts = [], []
    for ref in map(import_url, IMPORT_RE.finditer(strip_comments(styles))):
        if ref.startswith(('http:', 'https:', '//')):
            fonts.append(f'@import url("{ref}");')
            continue
        path = posixpath.normpath(ref)
        if path.startswith('tokens/') and os.path.exists(os.path.join(SRC, slug, path)):
            tokens.append(path)
    return tokens, fonts


def detect_scheme_attr(texts, cfg):
    counts = {}
    for text in texts:
        for m in re.finditer(r'\[\s*(data-(?:[a-z]{2}-)?(?:theme|scheme|palette|accent))\s*=\s*["\']?([\w-]+)',
                             strip_comments(text)):
            if m.group(1) in cfg.get('renameAttrs', {}):
                continue
            counts.setdefault(m.group(1), set()).add(m.group(2))
    if not counts:
        return None
    return max(counts, key=lambda k: len(counts[k]))


def build_theme(slug, name, source, cfg, prose_references=None):
    tokens, font_imports = load_order(slug)
    manifest = {r['path']: int(r['bytes']) for r in read_tsv(os.path.join(SRC, slug, 'MANIFEST.tsv'))}
    raw = {f: open(os.path.join(SRC, slug, f), encoding='utf-8').read() for f in tokens}
    problems = []

    scheme_attr = None if cfg.get('schemeClassPrefix') else detect_scheme_attr(raw.values(), cfg)
    class_prefix = cfg.get('schemeClassPrefix')
    class_ids = set()
    if class_prefix:
        pat = re.escape(class_prefix) + r'([\w-]+)'
        for text in raw.values():
            class_ids.update(re.findall(pat, strip_comments(text)))

    imports, assets, unresolved, sections = list(font_imports), {}, [], []
    replacement_url = font_policy.stylesheet_url(slug)
    if replacement_url:
        imports.append(f'@import url("{replacement_url}");')
    for f in tokens:
        css = font_policy.rewrite(raw[f], slug)
        for old, new in cfg.get('renameAttrs', {}).items():
            css = attr_re(old).sub(r'[\1' + new, css)
        if scheme_attr and scheme_attr != 'data-scheme':
            css = attr_re(scheme_attr).sub(r'[\1data-scheme', css)
        if class_prefix:
            css = re.sub(re.escape(class_prefix) + r'(' + '|'.join(map(re.escape, sorted(class_ids, key=len, reverse=True))) + r')(?![\w-])',
                         r'[data-scheme="\1"]', css)
        if f in cfg.get('rootGuard', []):
            css = rewrite_root_items(css, lambda r: r + ':not([data-scheme])')

        def hoist(m):
            ref = import_url(m)
            if not ref.startswith(('http:', 'https:', '//')):
                problems.append(f'{f}: local @import {ref} was dropped')
                return ''
            if m.group(0) not in imports:
                imports.append(m.group(0))
            return ''
        css = sub_code(IMPORT_RE, hoist, css)

        def relink(m):
            quote, ref = m.group(1), m.group(2).strip()
            # '#x' and '%23x' are fragment references (e.g. an SVG filter inside a data: URI), not files.
            if not ref or ref.lower().startswith(('data:', 'http:', 'https:', '//', '#', '%23')):
                return m.group(0)
            bare = re.split(r'[?#]', ref)[0]
            suffix = ref[len(bare):]
            path = posixpath.normpath(posixpath.join(posixpath.dirname(f), bare))
            if path.startswith('..'):
                unresolved.append(ref)
                return m.group(0)
            if path in manifest:
                assets[path] = manifest[path]
            elif path not in unresolved:
                unresolved.append(path)
            return f'url({quote}assets/{path}{suffix}{quote})'
        css = sub_code(URL_RE, relink, css)
        sections.append(f'/* ── {f} ' + '─' * max(4, 60 - len(f)) + ' */\n' + css.strip() + '\n')

    body = '\n'.join(sections)
    plain = strip_comments(body)

    # Scheme ids in order of first appearance, and a default paired with :root in one selector list.
    ids, root_paired, block_names = [], None, {}

    def scan(prelude):
        nonlocal root_paired
        lead, sel, _ = selector_parts(prelude)
        found = re.findall(r'\[data-scheme\s*=\s*["\']?([\w-]+)', sel)
        for s in found:
            if s not in ids:
                ids.append(s)
        items = [it.strip() for it in split_top(sel)] if sel and not sel.startswith('@') else []
        if found and ':root' in items and root_paired is None:
            root_paired = found[0]
        if len(found) == 1 and items and items[-1].startswith('[data-scheme') and found[0] not in block_names:
            comments = re.findall(r'/\*(.*?)\*/', lead, re.S)
            if comments:
                label = re.sub(r'^\s*\d+\s*[—–.-]\s*', '', comments[-1].strip())
                label = re.split(r'\s[—–-]\s|[.(:\n]', label)[0].strip()
                if norm(label) == norm(found[0]):
                    block_names[found[0]] = label
        return prelude
    map_preludes(body, scan)

    for s in ids:
        block = re.search(r'\[data-scheme\s*=\s*["\']?' + re.escape(s) + r'["\']?\][^{]*\{([^}]*)\}', plain)
        if block:
            m = re.search(r'--[\w-]*(?:theme|palette|scheme)-(?:name|label)\s*:\s*["\']([^"\']+)["\']', block.group(1))
            if m:
                block_names[s] = m.group(1)

    default_cfg = cfg.get('defaultScheme', {})
    default_id = default_cfg.get('id') or root_paired
    if not default_id:
        problems.append('no default scheme: add defaultScheme to tools/theme_config.json')
        default_id = 'default'
    default_has_block = default_id in ids
    if default_has_block:
        ids.remove(default_id)
    ids.insert(0, default_id)
    body = apply_contract(body, default_id, default_has_block)
    if cfg.get('baseColorScheme'):
        # Declare the base color-scheme so light schemes don't inherit dark from a parent scheme.
        body = (f'/* ── Riosoma: base color-scheme ── */\n:root, [data-scheme] {{ color-scheme: {cfg["baseColorScheme"]}; }}\n\n'
                + body)
    if default_cfg.get('name'):
        block_names[default_id] = default_cfg['name']

    modes = []
    for m in re.findall(r'\[data-mode\s*=\s*["\']?([\w-]+)', plain):
        if m not in modes:
            modes.append(m)
    default_mode = None
    if modes:
        paired = []

        def find_mode(prelude):
            _, sel, _ = selector_parts(prelude)
            items = [it.strip() for it in split_top(sel)] if sel and not sel.startswith('@') else []
            if ':root' in items:
                paired.extend(re.findall(r'\[data-mode\s*=\s*["\']?([\w-]+)', sel))
            return prelude
        map_preludes(body, find_mode)
        default_mode = paired[0] if paired else ('dark' if 'light' in modes and 'dark' not in modes else 'light')
        if default_mode not in modes:
            modes.insert(0, default_mode)
    surfaces = []
    for s in re.findall(r'\[data-surface\s*=\s*["\']?([\w-]+)', plain):
        if s not in surfaces:
            surfaces.append(s)
    other_attrs = sorted({a for a in re.findall(r'\[\s*(data-[\w-]+)', strip_comments(body)) if a not in UNIFORM})

    # Leftovers mean a selector escaped the rewrite.
    if scheme_attr and scheme_attr != 'data-scheme' and attr_re(scheme_attr).search(strip_comments(body)):
        problems.append(f'{scheme_attr} selectors remain after rewrite')
    for old in cfg.get('renameAttrs', {}):
        if attr_re(old).search(strip_comments(body)):
            problems.append(f'{old} selectors remain after rewrite')
    if class_prefix and re.search(re.escape(class_prefix) + r'[\w-]', strip_comments(body)):
        problems.append(f'{class_prefix}* selectors remain after rewrite')
    if not default_has_block and not re.search(r'(?:^|[\s,]):root\s*,\s*\[data-scheme\]', strip_comments(body)):
        problems.append(f'default scheme {default_id} lives at :root, but no :root rule matches [data-scheme]')
    for s in ids[1:] if not default_has_block else ids:
        if not re.search(r'\[data-scheme\s*=\s*["\']?' + re.escape(s) + r'["\']?\]', strip_comments(body)):
            problems.append(f'scheme {s} has no selector')

    for scheme, patch in cfg.get('schemePatches', {}).items():
        # Fixes for schemes that are broken in the original design system.  Each patch comes after
        # the scheme's own block, so it wins.
        decls = ' '.join(f'{k}: {v};' for k, v in patch['set'].items())
        sel = f'[data-scheme="{scheme}"]' + (', :root:where(:not([data-scheme]))' if scheme == default_id else '')
        body += f'\n/* ── Riosoma fix: {patch["why"]} */\n{sel} {{ {decls} }}\n'
    values = {}
    for var_name, value in re.findall(r'(--[\w-]+)\s*:\s*([^;{}]*)', strip_comments(body)):
        values.setdefault(var_name, []).append(value.strip())
    names = set(values)
    mapping, how = semantic.resolve(values, element_hints(body), cfg.get('semantic', {}))
    for token, src in mapping.items():
        if src is None:
            problems.append(f'semantic token --rio-{token} has no source: add it under "semantic" in tools/theme_config.json')
        elif src.startswith('--') and not src.startswith('--rio-') and src not in names:
            problems.append(f'semantic token --rio-{token} points at {src}, which the theme never defines')
    body += '\n/* ── Riosoma semantic layer (see themes/README.md) ' + '─' * 14 + ' */\n' + semantic.css_block(mapping)

    header = (f'/* Riosoma theme: {name}\n'
              f'   Generated by tools/build_themes.py from design-systems/{slug}/. Edit the source or the build, not this file.\n'
              f'   Color scheme: data-scheme="<id>" on <html> or any container. Default: {default_id}.\n'
              + (f'   Mode: data-mode="{"|".join(modes)}" (default {default_mode}).\n' if modes else '')
              + (f'   Surface: data-surface="{"|".join(surfaces)}" on a container.\n' if surfaces else '')
              + '   Scheme, mode, and surface ids are listed in theme.json. */\n')
    font_rules, remote, dropped = [], {}, []
    for ref in dict.fromkeys(import_url(IMPORT_RE.match(i)) for i in imports):
        if 'font-awesome/' in ref or 'fontawesome-free@' in ref:
            dropped.append(ref)
        elif urlsplit(ref).hostname in FONT_HOSTS:
            rules, files = remote_fonts.cached_faces(ref)
            rules = font_policy.adjust_faces(rules, slug)
            font_rules.append(rules)
            remote.update((f['path'], f) for f in files)
        else:
            problems.append(f'Unsupported remote import: {ref}')
    def localize_face(match):
        if not re.search(r'url\(\s*[\"\']?(?:https?:|//)', match.group(0)):
            return match.group(0)
        local = re.search(r"local\(\s*([\"'])(.*?)\1\s*\)", match.group(0))
        family = re.search(r'font-family\s*:\s*([^;]+);', match.group(0), re.I)
        if local and family:
            # Aliases in the source can contain stale URLs. Reuse the imported family's current faces.
            aliases = []
            for face in remote_fonts.FACE_RE.finditer('\n'.join(font_rules)):
                source_family = re.search(r'font-family\s*:\s*([^;]+);', face.group(0), re.I)
                if source_family and source_family.group(1).strip().strip('\"\'') == local.group(2):
                    aliases.append(re.sub(r'font-family\s*:[^;]+;', lambda _: f'font-family: {family.group(1)};', face.group(0), flags=re.I))
            if aliases:
                return '\n'.join(aliases)
        rules, files = remote_fonts.local_faces(match.group(0), '')
        remote.update((f['path'], f) for f in files)
        return rules

    body = remote_fonts.FACE_RE.sub(localize_face, body)
    body, removed_important, removed_motion = sanitize_css(body)
    if prose_references is not None:
        prose_references[slug] = '@layer rio.theme {\n' + '\n\n'.join(font_rules) + '\n' + body + '}\n'
    body = scope_prose(body)
    css = header + '\n@layer rio.theme {\n' + '\n\n'.join(font_rules) + '\n' + body + '}\n'

    # Status fills share the accent on-color only when the design has no dedicated ink.
    on_colors = {}
    for status, aliases in {'success': ['success', 'positive', 'good', 'ok'],
                            'warning': ['warning', 'warn', 'caution'],
                            'danger': ['danger', 'error', 'critical', 'bad'],
                            'info': ['info', 'information']}.items():
        candidates = [candidate for alias in aliases for candidate in
                      (f'on-{alias}', f'text-on-{alias}', f'{alias}-ink', f'{alias}-contrast')]
        on_colors[f'on-{status}'] = next((found for candidate in candidates
                                        if (found := semantic.match(candidate, values,
                                                                    semantic.system_prefixes(names), 'color'))),
                                       '--rio-on-accent')

    theme = {
        'id': slug,
        'name': name,
        'css': 'theme.css',
        'defaultScheme': default_id,
        'schemes': [{'id': s, 'name': clean_name(block_names.get(s), s)} for s in ids],
        'modes': modes,
        'defaultMode': default_mode,
        'surfaces': surfaces,
        'otherAttributes': other_attrs,
        'externalImports': [],
        'remoteFonts': [remote[p] for p in sorted(remote)],
        'droppedImports': dropped,
        'removedImportant': removed_important,
        'removedMotionRules': removed_motion,
        'semantic': {f'--rio-{t}': src for t, src in mapping.items()},
        'legibilityOnColors': on_colors,
        'assets': [{'path': f'assets/{p}', 'bytes': b} for p, b in sorted(assets.items())],
        'unresolvedUrls': unresolved,
        'source': {
            'designSystem': f'design-systems/{slug}',
            'originalSchemeSelector': class_prefix and f'{class_prefix}<id>' or (scheme_attr and f'[{scheme_attr}="<id>"]'),
            'tokenFiles': tokens,
            'zipFile': source['dropbox_file'],
            'zipContentHash': source['dropbox_content_hash'],
        },
    }
    return css, theme, problems


def sanitize_css(css):
    """Remove priority flags and universal motion overrides owned by the app."""
    removed_important = 0
    removed_motion = 0

    def clean(m):
        nonlocal removed_important
        text = m.group(0)
        if text.startswith('/*'):
            # These instructions describe remote loading that the generated theme no longer uses.
            return '' if re.search(r'@import|https?://|!\s*important', text, re.I) else text
        if text.startswith(('"', "'")):
            return text
        removed_important += 1
        return ''

    css = re.sub(r"/\*.*?\*/|\"(?:\\.|[^\"\\])*\"|'(?:\\.|[^'\\])*'|!\s*important\b", clean, css, flags=re.S | re.I)
    universal = re.compile(r'^(?:(?:html|body|:root)\s+(?:>\s*)?)*\*(?:::{0,1}(?:before|after))?$', re.I)
    motion = re.compile(r'^\s*(?:-(?:webkit|moz|ms)-)?(?:animation(?:-[\w-]+)?|transition(?:-[\w-]+)?|scroll-behavior)\s*:', re.I)

    def drop(prelude, body):
        nonlocal removed_motion
        _, sel, _ = selector_parts(prelude)
        decls = [d for d in split_top(strip_comments(body), ';') if d.strip()]
        if (sel and all(universal.fullmatch(s.strip()) for s in split_top(sel))
                and decls and all(motion.match(d) for d in decls)):
            removed_motion += 1
            return None
        return prelude

    return map_preludes(css, drop, with_body=True), removed_important, removed_motion


def stable_color_precision(value):
    """Normalize browser-resolved OKLab colors only at the output boundary."""
    if isinstance(value, dict):
        return {key: stable_color_precision(item) for key, item in value.items()}
    if isinstance(value, list):
        return [stable_color_precision(item) for item in value]
    if not isinstance(value, str):
        return value

    def component(match):
        # Five decimal places give <= 0.000005 error per component, far below
        # visible color changes, with ample room above libm's last-digit noise.
        rounded = f'{float(match.group()):.5f}'.rstrip('0').rstrip('.')
        return '0' if rounded == '-0' else rounded

    return re.sub(r'\boklab\(([^()]*)\)',
                  lambda match: 'oklab(' + re.sub(r'[+-]?(?:\d*\.\d+|\d+)(?:[eE][+-]?\d+)?',
                                                 component, match.group(1)) + ')', value)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--no-browser', action='store_true', help='skip the headless browser checks')
    ap.add_argument('--refresh-fonts', action='store_true', help='refresh the committed font stylesheet cache')
    ap.add_argument('--update-baseline', action='store_true',
                    help='accept the current semantic colors as the new baseline (for intended changes)')
    args = ap.parse_args()

    config = json.load(open(CONFIG, encoding='utf-8'))
    sources = {r['slug']: r for r in read_tsv(os.path.join(SRC, 'SOURCES.tsv'))}
    os.makedirs(OUT, exist_ok=True)

    if args.refresh_fonts:
        urls = set()
        for slug in sources:
            tokens, imports = load_order(slug)
            texts = imports + [open(os.path.join(SRC, slug, f), encoding='utf-8').read() for f in tokens]
            for text in texts:
                for match in IMPORT_RE.finditer(strip_comments(text)):
                    ref = import_url(match)
                    if urlsplit(ref).hostname in FONT_HOSTS:
                        urls.add(ref)
            replacement_url = font_policy.stylesheet_url(slug)
            if replacement_url:
                urls.add(replacement_url)
        remote_fonts.refresh(urls)

    themes, failures, prose_references = {}, {}, {}
    for slug, source in sorted(sources.items()):
        css, theme, problems = build_theme(slug, source['name'], source, config.get(slug, {}), prose_references)
        old = os.path.join(OUT, slug, 'theme.json')
        if os.path.exists(old):
            previous_theme = json.load(open(old, encoding='utf-8'))
            previous = {s['id']: s.get('appearance') for s in previous_theme['schemes']}
            if args.no_browser:
                for key in ('legibility', 'legibilitySurfaces', 'legibilityAdjusted'):
                    if key in previous_theme:
                        theme[key] = previous_theme[key]
                old_css_path = os.path.join(OUT, slug, 'theme.css')
                if os.path.exists(old_css_path):
                    old_css = open(old_css_path, encoding='utf-8').read()
                    marker = '/* Riosoma legibility tier */'
                    if marker in old_css:
                        css = css.rstrip()[:-1] + '\n' + marker + old_css.split(marker, 1)[1]
            for s in theme['schemes']:
                if previous.get(s['id']):
                    s['appearance'] = previous[s['id']]
        os.makedirs(os.path.join(OUT, slug), exist_ok=True)
        with open(os.path.join(OUT, slug, 'theme.css'), 'w', encoding='utf-8') as fh:
            fh.write(css)
        themes[slug] = theme
        if problems:
            failures[slug] = problems

    report = None
    if not args.no_browser:
        env = dict(os.environ)
        if shutil.which('npm') and 'NODE_PATH' not in env:
            env['NODE_PATH'] = subprocess.run(['npm', 'root', '-g'], capture_output=True, text=True).stdout.strip()
        manifests = json.dumps({k: {'defaultScheme': t['defaultScheme'], 'schemes': [s['id'] for s in t['schemes']],
                                    'modes': t['modes'], 'defaultMode': t['defaultMode'], 'surfaces': t['surfaces'],
                                    'legibilityOnColors': t['legibilityOnColors'],
                                    'backgroundVar': config.get(k, {}).get('backgroundVar'),
                                    'assets': t['assets'], 'remoteFonts': t['remoteFonts'],
                                    'proseReference': prose_references[k],
                                    'semantic': {tok: kind for tok, (kind, _, _) in semantic.TOKENS.items()}}
                               for k, t in themes.items()})
        if args.update_baseline:
            env['RIO_UPDATE_BASELINE'] = '1'
        run = subprocess.run(['node', VERIFY, '--write-legibility'], input=manifests, capture_output=True, text=True, env=env)
        if run.returncode != 0:
            print('Browser checks failed to run; rerun with --no-browser to skip them.\n' + run.stderr[-2000:], file=sys.stderr)
            sys.exit(2)
        report = json.loads(run.stdout)
        for slug, result in report.items():
            themes[slug].update(result.pop('legibilityData'))
            for s in themes[slug]['schemes']:
                if s['id'] in result['appearance']:
                    s['appearance'] = result['appearance'][s['id']]
            if result['errors']:
                failures.setdefault(slug, []).extend(result['errors'])
        with open(os.path.join(OUT, 'verify-report.json'), 'w', encoding='utf-8') as fh:
            json.dump(report, fh, indent=2)
            fh.write('\n')

    # Browser contrast and accessibility checks above retain their full precision.
    # Normalize only serialized manifests and the generated legibility CSS tier;
    # original design-system CSS is preserved.
    for slug, theme in themes.items():
        css_path = os.path.join(OUT, slug, 'theme.css')
        with open(css_path, encoding='utf-8') as fh:
            css = fh.read()
        prefix, marker, tier = css.partition('/* Riosoma legibility tier */')
        if marker:
            with open(css_path, 'w', encoding='utf-8') as fh:
                fh.write(prefix + marker + stable_color_precision(tier))
        with open(os.path.join(OUT, slug, 'theme.json'), 'w', encoding='utf-8') as fh:
            json.dump(stable_color_precision(theme), fh, indent=2, ensure_ascii=False)
            fh.write('\n')
    index = [{'id': t['id'], 'name': t['name'], 'css': f'{t["id"]}/theme.css', 'manifest': f'{t["id"]}/theme.json',
              'defaultScheme': t['defaultScheme'], 'schemeCount': len(t['schemes']), 'modes': t['modes']}
             for t in themes.values()]
    with open(os.path.join(OUT, 'index.json'), 'w', encoding='utf-8') as fh:
        json.dump({'themes': index}, fh, indent=2, ensure_ascii=False)
        fh.write('\n')

    shutil.copyfile(os.path.join(ROOT, 'tools', 'themes-readme.md'), os.path.join(OUT, 'README.md'))
    font_policy.write_removals(OUT)
    license_command = ['node', os.path.join(ROOT, 'tools', 'font_license_gate.cjs')]
    if args.no_browser:
        license_command.append('--allow-missing-assets')
    subprocess.run(license_command, check=True)

    total = sum(len(t['schemes']) for t in themes.values())
    print(f'Built {len(themes)} themes with {total} color schemes.')
    if report:
        warned = {k: v['warnings'] for k, v in report.items() if v['warnings']}
        for slug, warnings in sorted(warned.items()):
            for w in warnings:
                print(f'  note  {slug}: {w}')
    for slug, problems in sorted(failures.items()):
        for p in problems:
            print(f'  FAIL  {slug}: {p}')
    sys.exit(1 if failures else 0)


if __name__ == '__main__':
    main()
