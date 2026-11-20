/** Only an app path on this server may follow sign-in. */
export function safeSignInNext(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048 || !value.startsWith('/')) return '/';
  if (value.startsWith('//') || value.includes('\\')) return '/';
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) return '/';
  }
  const base = 'https://next.invalid';
  const url = new URL(value, base);
  if (url.origin !== base || url.pathname === '/api' || url.pathname.startsWith('/api/')) return '/';
  return `${url.pathname}${url.search}${url.hash}`;
}
