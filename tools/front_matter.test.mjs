import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const files = [
  'README.md',
  'LICENSE',
  'CONTRIBUTING.md',
  'SECURITY.md',
  'CHANGELOG.md',
  'THIRD_PARTY_NOTICES.md',
];

function links(markdown) {
  // Command examples and inline code describe syntax, rather than links to repository files.
  const text = markdown
    .replace(/^\s*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\s*\1\s*$/gm, '')
    .replace(/`[^`\n]*`/g, '');
  const targets = [...text.matchAll(/\]\(\s*(<[^>]+>|[^\s)]+)(?:\s+["'][^\n]*?["'])?\s*\)/g)].map((match) =>
    match[1].replace(/^<|>$/g, ''),
  );
  for (const match of text.matchAll(/^\s*\[[^\]]+\]:\s*(<[^>]+>|[^\s]+)(?:\s|$)/gm)) {
    targets.push(match[1].replace(/^<|>$/g, ''));
  }
  for (const match of text.matchAll(/\b(?:href|src)=["']([^"']+)["']/g)) targets.push(match[1]);
  return targets;
}

function linkFailures(file, markdown) {
  const failures = [];
  for (const target of links(markdown)) {
    if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(target)) continue;
    const [pathname, fragment] = target.split('#');
    const destination = pathname
      ? resolve(dirname(resolve(root, file)), decodeURIComponent(pathname.split('?')[0]))
      : resolve(root, file);
    if (file === 'README.md' && target === 'docs/media/home.png') continue;
    if (!existsSync(destination)) {
      failures.push(`${file}: ${target}`);
      continue;
    }
    if (fragment && statSync(destination).isFile()) {
      const content = readFileSync(destination, 'utf8');
      const anchors = [...content.matchAll(/^#{1,6}\s+(.+)$/gm)].map((match) =>
        match[1]
          .toLowerCase()
          .replace(/[^\p{L}\p{N}\s_-]/gu, '')
          .replace(/\s/g, '-'),
      );
      if (!anchors.includes(decodeURIComponent(fragment))) failures.push(`${file}: ${target}`);
    }
    assert.ok(!relative(root, destination).startsWith('..'), `Link leaves repository: ${target}`);
  }
  return failures;
}

test('all relative links in release files resolve, except the named screenshot placeholder', () => {
  for (const file of files) {
    assert.deepEqual(linkFailures(file, readFileSync(resolve(root, file), 'utf8')), []);
  }
});

test('detects broken inline, reference, image, HTML, and fragment links', () => {
  const markdown = [
    '[Broken](docs/missing-page.md)',
    '[Reference][missing]',
    '[missing]: docs/missing-reference.md',
    '![Image](docs/media/missing.png)',
    '<a href="docs/missing-html.md">Link</a>',
    '[Section](README.md#missing-section)',
    '```sh',
    '[example](docs/command-syntax.md)',
    '```',
    '`[example](docs/inline-syntax.md)`',
  ].join('\n');
  assert.equal(linkFailures('README.md', markdown).length, 5);
  assert.deepEqual(linkFailures('README.md', '![Screenshot](docs/media/home.png)'), []);
  assert.equal(linkFailures('CONTRIBUTING.md', '![Screenshot](docs/media/home.png)').length, 1);
});

test('retains the requested license opening and the separately licensed port', () => {
  const license = readFileSync(resolve(root, 'LICENSE'), 'utf8');
  assert.ok(license.startsWith('# Nice People License, Version 1.0\n\n'));
  assert.ok(
    license.includes(
      "This software was created to be used and enjoyed by nice people who are kind to others and prioritize love.  It was not designed to be used by assholes, and these terms expressly forbid its use by those defined as an 'asshole' herein.",
    ),
  );
  assert.match(license, /4\. The Asshole Clause/);
  assert.equal(
    JSON.parse(readFileSync(resolve(root, 'packages/ecologits/package.json'), 'utf8')).license,
    'MPL-2.0',
  );
  assert.match(readFileSync(resolve(root, 'packages/ecologits/LICENSE'), 'utf8'), /Mozilla Public License/);
});

test('preserves the reviewed license text byte for byte', () => {
  const license = readFileSync(resolve(root, 'LICENSE'));
  assert.equal(
    createHash('sha256').update(license).digest('hex'),
    '372dbbc7235569903dc92d57a5081f95bf214a54517b5e062ccd4423cd092bb4',
  );
});
