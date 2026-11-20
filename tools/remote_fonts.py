"""Cached font stylesheets and local font sources for deterministic theme builds."""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from hashlib import sha256
import json
from pathlib import Path
import re
import time
from urllib.parse import urljoin, urlsplit
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

CACHE = Path(__file__).resolve().parent / 'font-cache'
FONT_HOSTS = ('fonts.googleapis.com',)
USER_AGENT = ('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
              'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36')
FACE_RE = re.compile(r'@font-face\s*\{([^{}]*)\}', re.I)
URL_RE = re.compile(r'''url\(\s*(["']?)([^"')]+)\1\s*\)''', re.I)


def fetch(url):
    for attempt in range(3):
        try:
            with urlopen(Request(url, headers={'User-Agent': USER_AGENT}), timeout=30) as response:
                data = response.read()
                length = response.headers.get('Content-Length')
                if length is not None and len(data) != int(length):
                    raise ValueError(f'Incomplete response: {url}')
                return data
        except (URLError, TimeoutError, ConnectionResetError) as error:
            if attempt == 2 or (isinstance(error, HTTPError) and error.code != 429 and error.code < 500):
                raise
            time.sleep(attempt + 1)


def cache_name(url):
    return sha256(url.encode('utf-8')).hexdigest() + '.css'


def local_faces(css, stylesheet_url):
    """Keep face descriptors, but make every source a local WOFF2 file."""
    faces, fonts = [], {}
    for match in FACE_RE.finditer(re.sub(r'/\*.*?\*/', '', css, flags=re.S)):
        body = match.group(1)
        family_match = re.search(r'''font-family\s*:\s*([^;]+);''', body, re.I)
        if not family_match:
            raise ValueError(f'Font face without a family: {stylesheet_url}')
        family = family_match.group(1).strip().strip('\"\'')
        slug = re.sub(r'[^a-z0-9]+', '-', family.lower()).strip('-')

        def relink(m):
            url = urljoin(stylesheet_url, m.group(2))
            if (urlsplit(url).scheme != 'https' or urlsplit(url).hostname != 'fonts.gstatic.com'
                    or not urlsplit(url).path.endswith('.woff2')):
                raise ValueError(f'Expected an HTTPS WOFF2 source: {url}')
            digest = sha256(url.encode('utf-8')).hexdigest()[:12]
            local = f'assets/fonts/remote/{slug}-{digest}.woff2'
            fonts[local] = {'path': local, 'sourceUrl': url, 'family': family}
            return f'url({local})'

        rewritten, count = URL_RE.subn(relink, body)
        if not count:
            raise ValueError(f'Font face without a downloadable source: {stylesheet_url}')
        faces.append('@font-face {' + rewritten + '}')
    if not faces:
        raise ValueError(f'No font faces in cache: {stylesheet_url}')
    return '\n\n'.join(faces), list(fonts.values())


def refresh(urls):
    """Fetch and validate all responses before replacing the committed cache."""
    urls = sorted(set(urls))

    def download(url):
        if urlsplit(url).scheme != 'https' or urlsplit(url).hostname != 'fonts.googleapis.com':
            raise ValueError(f'Expected a Google Fonts stylesheet: {url}')
        css = fetch(url).decode('utf-8')
        local_faces(css, url)
        return url, css

    with ThreadPoolExecutor(max_workers=6) as pool:
        responses = list(pool.map(download, urls))
    CACHE.mkdir(parents=True, exist_ok=True)
    index = {}
    fetched = datetime.now(timezone.utc).date().isoformat()
    for url, css in responses:
        filename = cache_name(url)
        (CACHE / filename).write_text(css, encoding='utf-8')
        index[url] = {'file': filename, 'fetched': fetched}
    (CACHE / 'index.json').write_text(json.dumps(index, indent=2) + '\n', encoding='utf-8')


def cached_faces(url):
    try:
        index = json.loads((CACHE / 'index.json').read_text(encoding='utf-8'))
        entry = index[url]
        if entry['file'] != cache_name(url):
            raise ValueError(f'Unexpected font cache filename: {url}')
        css = (CACHE / entry['file']).read_text(encoding='utf-8')
    except (FileNotFoundError, KeyError) as error:
        raise ValueError(f'Missing font cache for {url}. Run tools/build_themes.py --refresh-fonts.') from error
    return local_faces(css, url)
