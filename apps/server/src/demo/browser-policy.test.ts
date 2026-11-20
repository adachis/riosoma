import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { demoBrowserPolicy } from './browser-policy.js';

it('preserves inherited script and style refusals, sandboxing, and framing isolation', () => {
  const policy = demoBrowserPolicy(
    "default-src 'self'; script-src 'none'; style-src 'none'; sandbox allow-scripts; frame-ancestors 'none'",
  );
  for (const name of [
    'script-src',
    'script-src-elem',
    'script-src-attr',
    'style-src',
    'style-src-elem',
    'style-src-attr',
  ])
    expect(policy).toContain(`${name} 'none'`);
  expect(policy).toContain('sandbox allow-scripts');
  expect(policy).toContain("frame-ancestors 'none'");
});

it('removes external destinations and remote reporting from a permissive policy', () => {
  const policy = demoBrowserPolicy(
    'default-src *; connect-src https: wss:; img-src * data:; frame-src https:; form-action *; report-uri /reports; report-to remote',
  );
  expect(policy).not.toMatch(/\*|https:|wss:|report-uri|report-to/);
  expect(policy).toContain("connect-src 'none'");
  expect(policy).toContain('img-src data:');
  expect(policy).toContain("frame-src 'none'");
  expect(policy).toContain("form-action 'none'");
});

it('keeps the shell recovery hash in both script policies without inline attribute permission', () => {
  const source = readFileSync(new URL('../../../web/public/startup-recovery.js', import.meta.url), 'utf8');
  const hash = `'sha256-${createHash('sha256').update(source).digest('base64')}'`;
  const policy = demoBrowserPolicy(`default-src 'self'; script-src 'self' ${hash}`);
  const directives = new Map(
    policy.split('; ').map((part) => {
      const [name, ...sources] = part.split(' ');
      return [name, sources];
    }),
  );
  expect(directives.get('script-src')).toEqual(["'self'", hash]);
  expect(directives.get('script-src-elem')).toEqual(["'self'", hash]);
  expect(directives.get('script-src-attr')).toEqual(["'none'"]);
  expect(policy).not.toContain('unsafe-inline');
});
