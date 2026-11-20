const destinations: Record<string, readonly string[]> = {
  'default-src': ["'self'"],
  'script-src': ["'self'"],
  'script-src-elem': ["'self'"],
  'script-src-attr': ["'none'"],
  'style-src': ["'self'"],
  'style-src-elem': ["'self'"],
  'style-src-attr': ["'none'"],
  'font-src': ["'self'"],
  'img-src': ["'self'", 'data:', 'blob:'],
  'media-src': ["'self'"],
  'connect-src': ["'self'"],
  'worker-src': ["'self'", 'blob:'],
  'child-src': ["'self'", 'blob:'],
  'manifest-src': ["'self'"],
  'frame-src': ["'self'", 'blob:'],
  'object-src': ["'none'"],
  'base-uri': ["'none'"],
  'form-action': ["'self'"],
};

const fallbacks: Record<string, readonly string[]> = {
  'script-src-elem': ['script-src', 'default-src'],
  'script-src-attr': ['script-src', 'default-src'],
  'style-src-elem': ['style-src', 'default-src'],
  'style-src-attr': ['style-src', 'default-src'],
  'frame-src': ['child-src', 'default-src'],
  'worker-src': ['child-src', 'script-src', 'default-src'],
};

/** Narrow the existing policy, preserving site isolation and sandboxing without remote reports. */
export function demoBrowserPolicy(current: string): string {
  const directives = new Map(
    current.split(';').map((part) => {
      const [name, ...sources] = part.trim().split(/\s+/);
      return [name, sources] as const;
    }),
  );
  const policy = Object.entries(destinations).map(([name, allowed]) => {
    const inherited = [name, ...(fallbacks[name] ?? (name.endsWith('-src') ? ['default-src'] : []))]
      .map((directive) => directives.get(directive))
      .find((sources) => sources !== undefined);
    const hashes =
      name === 'script-src' || name === 'script-src-elem'
        ? (inherited ?? []).filter((source) => /^'sha256-[A-Za-z0-9+/]+=*'$/.test(source))
        : [];
    const sources = inherited
      ? [...allowed.filter((source) => inherited.includes(source)), ...hashes]
      : allowed;
    return `${name} ${sources.length ? sources.join(' ') : "'none'"}`;
  });
  for (const name of ['frame-ancestors', 'sandbox']) {
    const sources = directives.get(name);
    if (sources) policy.push([name, ...sources].join(' '));
  }
  if (!directives.has('frame-ancestors')) policy.push("frame-ancestors 'self'");
  return policy.join('; ');
}
