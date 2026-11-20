/** The server marks HTML served through a verified public domain. */
export function onPublicDomain(): boolean {
  return typeof document !== 'undefined' && Boolean(document.querySelector('meta[name="rio-public-domain"]'));
}

export function publicPagePath(path: string): boolean {
  return (
    /^\/(?:f|v|b)\/[^/]+$/.test(path) ||
    /^\/f\/[^/]+\/edit$/.test(path) ||
    path === '/signatures' ||
    path === '/bookings/cancel'
  );
}
