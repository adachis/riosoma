import type { ReactNode } from 'react';

/** Branding and the page's status and actions have separate zones in the reserved footer. */
export function ShellFooter({ brand, page }: { brand?: ReactNode; page?: ReactNode }) {
  return (
    <footer className="rio-shell__footer">
      {brand && <div className="rio-shell__footer-brand">{brand}</div>}
      <div className="rio-shell__footer-page">{page}</div>
    </footer>
  );
}
