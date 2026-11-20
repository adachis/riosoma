"""Apply reviewed font substitutions before asset collection or semantic mapping."""
import json
from pathlib import Path
import re
from urllib.parse import quote_plus

import remote_fonts

ROOT = Path(__file__).resolve().parent
FAMILIES = json.loads((ROOT / 'font-licenses.json').read_text())['families']
SUBSTITUTIONS = json.loads((ROOT / 'font_substitutions.json').read_text())
GENERICS = {'serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui',
            'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded', 'emoji', 'math', 'fangsong'}
# Named operating-system fonts need no bundled files, but generic stacks make the policy
# unambiguous and give platforms control over their native fallback.
SYSTEM_FALLBACKS = {
    **dict.fromkeys(['Arial', 'Arial Black', 'Arial Narrow', 'Helvetica', 'Helvetica Neue',
                    'Futura', 'Century Gothic', 'Trebuchet MS', 'Impact', 'Haettenschweiler',
                    'Geneva', 'Verdana', 'Segoe UI', '-apple-system', 'BlinkMacSystemFont',
                    'SF Pro Text', 'SF Pro Display', 'Helvetica Neue Condensed',
                    'News Gothic Extra Condensed'], 'system-ui'),
    **dict.fromkeys(['Georgia', 'Times', 'Times New Roman', 'Iowan Old Style',
                    'Hiragino Mincho ProN', 'Yu Mincho'], 'serif'),
    **dict.fromkeys(['SFMono-Regular', 'SF Mono', 'Menlo', 'Monaco', 'Consolas',
                    'Courier New', 'Liberation Mono'], 'ui-monospace'),
    **dict.fromkeys(['Segoe Script', 'Snell Roundhand', 'Marker Felt', 'Comic Sans MS',
                    'Bradley Hand', 'Brush Script MT'], 'cursive'),
}
DECLARATION = re.compile(r'([\w-]+)(\s*:\s*)([^;{}]+)')


def substitutions(theme):
    rows = [row for row in SUBSTITUTIONS if row['theme'] == theme]
    if len({row['originalFamily'] for row in rows}) != len(rows):
        raise ValueError(f'Duplicate font substitution in {theme}')
    for row in rows:
        if row['replacement'] not in FAMILIES or row['license'] != FAMILIES[row['replacement']]['license']:
            raise ValueError(f'Unverified replacement in {theme}: {row["replacement"]}')
    return rows


def rewrite(css, theme):
    replacements = {row['originalFamily']: row['replacement'] for row in substitutions(theme)}

    def remove_face(match):
        family = re.search(r'font-family\s*:\s*([^;]+)', match.group(0), re.I)
        name = family.group(1).strip().strip('\"\'') if family else None
        if name not in replacements:
            raise ValueError(f'Unreviewed bundled font in {theme}: {name}')
        return ''

    css = remote_fonts.FACE_RE.sub(remove_face, css)

    def declaration(match):
        prop, colon, value = match.groups()
        # Custom properties can hold families or entire font shorthands. Restrict replacements
        # to declaration values so asset URLs, selectors, and source variable names stay intact.
        if prop != 'font' and prop != 'font-family' and not prop.startswith('--'):
            return match.group(0)
        names = {**SYSTEM_FALLBACKS, **replacements}
        parts = re.split(r'(url\([^)]*\))', value, flags=re.I)
        for i in range(0, len(parts), 2):
            for original in sorted(names, key=len, reverse=True):
                replacement = names[original]
                token = replacement if replacement in GENERICS else json.dumps(replacement)
                pattern = r'([\"\'])' + re.escape(original) + r'\1|(?<![\w\"\'-])' + re.escape(original) + r'(?![\w\"\'-])'
                parts[i] = re.sub(pattern, lambda _: token, parts[i])
        value = ''.join(parts)
        # Removing aliases often leaves identical adjacent fallbacks.
        if '(' not in value and (prop == 'font-family' or
                                  (prop.startswith('--') and re.search(r'font|family', prop))):
            value = ','.join(dict.fromkeys(part.strip() for part in value.split(',')))
        return prop + colon + value

    parts = re.split(r'(/\*.*?\*/)', css, flags=re.S)
    result = ''.join(('' if any(name in part for name in replacements) else part) if i % 2
                     else DECLARATION.sub(declaration, part) for i, part in enumerate(parts))
    return re.sub(r'(?m)^[ \t]+$', '', result)


def stylesheet_url(theme):
    specs = []
    for name in sorted({row['replacement'] for row in substitutions(theme) if row.get('loadReplacement', True)}):
        family = FAMILIES[name]
        weights = family['weights']
        variable = any(axis['tag'] == 'wght' for axis in family['axes'])
        values = [f'{min(weights)}..{max(weights)}'] if variable else [str(weight) for weight in weights]
        if 'italic' in family['styles']:
            spec = ':ital,wght@' + ';'.join(f'{italic},{weight}' for italic in (0, 1) for weight in values)
        else:
            spec = ':wght@' + ';'.join(values)
        specs.append('family=' + quote_plus(name) + spec)
    return 'https://fonts.googleapis.com/css2?' + '&'.join(specs) + '&display=swap' if specs else None


def adjust_faces(css, theme):
    adjustments = {}
    for row in substitutions(theme):
        if 'sizeAdjust' in row:
            name = row['replacement']
            if name in adjustments and adjustments[name] != row['sizeAdjust']:
                raise ValueError(f'Conflicting font sizing in {theme}: {name}')
            adjustments[name] = row['sizeAdjust']

    def adjust(match):
        family = re.search(r'font-family\s*:\s*([^;]+)', match.group(0), re.I)
        name = family.group(1).strip().strip('\"\'')
        if name not in adjustments:
            return match.group(0)
        return match.group(0)[:-1] + f'  size-adjust: {adjustments[name]};\n' + '}'

    return remote_fonts.FACE_RE.sub(adjust, css)


def write_removals(out):
    paths = sorted({row['theme'] + '/' + filename for row in SUBSTITUTIONS for filename in row['originalFiles']})
    lines = ['# Retired bundled font files', '',
             'These files are no longer referenced by generated themes.  Remove them from the asset bundle after refreshing the replacement fonts.', '',
             "Paths are relative to the theme asset bundle (the copy of the themes' binary assets kept outside the repository).", '']
    lines.extend('- `' + path + '`' for path in paths)
    (Path(out) / 'FONT-ASSET-REMOVALS.md').write_text('\n'.join(lines) + '\n')
