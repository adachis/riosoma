#!/usr/bin/env python3
"""Copy the fonts and textures each theme references out of the original design system zips.

The assets add up to a few hundred MB, so they stay out of git (see .gitignore). Each theme's
theme.json lists what it needs under "assets"; this script extracts those files into
themes/<theme>/assets/, where theme.css expects them.

Usage:
  python3 tools/fetch_theme_assets.py /path/to/design-system-zips            all themes
  python3 tools/fetch_theme_assets.py /path/to/design-system-zips kawaii y2k  just these
  python3 tools/fetch_theme_assets.py --remote-fonts                        remote fonts
  python3 tools/fetch_theme_assets.py --remote-fonts kawaii y2k             just these
"""
import json
import os
import sys
import zipfile
from hashlib import sha256
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import remote_fonts
import font_policy

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
THEMES = os.path.join(ROOT, 'themes')


def fetch_remote(wanted, record_hashes=False):
    """Keep download sizes beside the ignored binaries, not in generated manifests."""
    fingerprint_path = remote_fonts.CACHE / 'files.json'
    fingerprints = json.loads(fingerprint_path.read_text(encoding='utf-8'))
    approved = {}
    for url in json.loads((remote_fonts.CACHE / 'index.json').read_text(encoding='utf-8')):
        _, files = remote_fonts.cached_faces(url)
        for font in files:
            if font['family'] not in font_policy.FAMILIES:
                raise ValueError(f'Unapproved font family: {font["family"]}')
            approved[font['sourceUrl']] = font
    jobs = {}
    sizes_by_theme = {}
    for manifest in sorted(Path(THEMES).glob('*/theme.json')):
        theme = json.loads(manifest.read_text(encoding='utf-8'))
        if wanted and theme['id'] not in wanted:
            continue
        size_path = manifest.parent / 'assets/fonts/remote/sizes.json'
        sizes = json.loads(size_path.read_text(encoding='utf-8')) if size_path.exists() else {}
        sizes_by_theme[manifest.parent] = (size_path, sizes)
        for font in theme.get('remoteFonts', []):
            if approved.get(font['sourceUrl']) != font:
                raise ValueError(f'Unapproved font file: {font["path"]}')
            dest = manifest.parent / font['path']
            if not dest.resolve().is_relative_to((manifest.parent / 'assets/fonts/remote').resolve()):
                raise ValueError(f'Invalid remote font path: {font["path"]}')
            known = font.get('bytes', sizes.get(font['sourceUrl']))
            fingerprint = fingerprints.get(font['sourceUrl'])
            if not fingerprint and not record_hashes:
                raise ValueError('New font sources need --record-font-hashes after reviewing the font cache.')
            if fingerprint and dest.exists() and sha256(dest.read_bytes()).hexdigest() == fingerprint:
                continue
            jobs.setdefault(font['sourceUrl'], []).append((dest, sizes, known))

    def download(item):
        url, destinations = item
        data = remote_fonts.fetch(url)
        if data[:4] != b'wOF2':
            raise ValueError(f'Expected a WOFF2 font: {url}')
        fingerprint = sha256(data).hexdigest()
        if url in fingerprints and fingerprint != fingerprints[url]:
            raise ValueError(f'Font fingerprint changed: {url}')
        fingerprints[url] = fingerprint
        for dest, sizes, known in destinations:
            if known is not None and len(data) != known:
                raise ValueError(f'Font size changed: {url}')
            dest.parent.mkdir(parents=True, exist_ok=True)
            partial = dest.with_suffix('.part')
            partial.write_bytes(data)
            partial.replace(dest)
            sizes[url] = len(data)
        return len(destinations), len(data) * len(destinations)

    try:
        with ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(download, jobs.items()))
    finally:
        # Keep completed downloads after a transient failure so a retry only fetches missing files.
        for size_path, sizes in sizes_by_theme.values():
            if sizes:
                size_path.parent.mkdir(parents=True, exist_ok=True)
                size_path.write_text(json.dumps(sizes, indent=2, sort_keys=True) + '\n', encoding='utf-8')
        if record_hashes:
            fingerprint_path.write_text(json.dumps(fingerprints, indent=2, sort_keys=True) + '\n', encoding='utf-8')
    return sum(n for n, _ in results), sum(size for _, size in results)


def main():
    if len(sys.argv) < 2 or sys.argv[1] in ('-h', '--help'):
        print(__doc__)
        sys.exit(0 if len(sys.argv) > 1 else 2)
    if sys.argv[1] == '--remote-fonts':
        args = sys.argv[2:]
        copied, total = fetch_remote([arg for arg in args if arg != '--record-font-hashes'],
                                    '--record-font-hashes' in args)
        print(f'Copied {copied} assets ({total / 1e6:.1f} MB).')
        return
    zip_dir, wanted = sys.argv[1], sys.argv[2:]
    index = json.load(open(os.path.join(THEMES, 'index.json'), encoding='utf-8'))['themes']
    missing, copied, total = [], 0, 0
    for entry in index:
        if wanted and entry['id'] not in wanted:
            continue
        theme = json.load(open(os.path.join(THEMES, entry['manifest']), encoding='utf-8'))
        if not theme['assets']:
            continue
        zip_path = os.path.join(zip_dir, theme['source']['zipFile'])
        if not os.path.exists(zip_path):
            missing.append(f'{theme["id"]}: {zip_path} not found')
            continue
        with zipfile.ZipFile(zip_path) as zf:
            names = set(zf.namelist())
            for asset in theme['assets']:
                member = asset['path'][len('assets/'):]
                dest = os.path.join(THEMES, theme['id'], asset['path'])
                if os.path.exists(dest) and os.path.getsize(dest) == asset['bytes']:
                    continue
                if member not in names:
                    missing.append(f'{theme["id"]}: {member} not in {os.path.basename(zip_path)}')
                    continue
                os.makedirs(os.path.dirname(dest), exist_ok=True)
                with zf.open(member) as src, open(dest, 'wb') as out:
                    out.write(src.read())
                copied += 1
                total += asset['bytes']
    print(f'Copied {copied} assets ({total / 1e6:.1f} MB).')
    for m in missing:
        print(f'  missing  {m}')
    sys.exit(1 if missing else 0)


if __name__ == '__main__':
    main()
