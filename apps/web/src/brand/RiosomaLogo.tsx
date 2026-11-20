import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { useLingui } from '@lingui/react/macro';
import './brand.css';
import { preloadImport } from '../asset-recovery';

let introduced = false;

/**
 * The app's interface shows the wordmark alone.  The mascot is Rio, and the lockup is kept for
 * documentation and release material.  Static marks use transparent cutouts.  Only an introduction
 * loads the addressable artwork.
 */
export function RiosomaLogo({
  variant = 'wordmark',
  size = 'default',
  animate = false,
}: {
  variant?: 'lockup' | 'wordmark' | 'mascot';
  /** Sign-in, setup, and loading screens give the mark more presence than the app's header. */
  size?: 'default' | 'large';
  animate?: boolean;
}) {
  const { t } = useLingui();
  const ownsIntroduction = useRef(false);
  const element = useRef<HTMLSpanElement>(null);
  const [artwork, setArtwork] = useState<{
    markup: string;
    styles: { id: string; value: string }[];
  } | null>(null);
  const [settled, setSettled] = useState(false);
  const pending =
    animate &&
    !artwork &&
    !settled &&
    !introduced &&
    !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  useEffect(() => {
    if (
      !animate ||
      (introduced && !ownsIntroduction.current) ||
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    )
      return;
    let active = true;
    const request = new AbortController();
    void preloadImport(() => import('./entrance'))
      .then(({ loadArtwork }) => loadArtwork(variant, request.signal))
      .then((artwork) => {
        if (active && (!introduced || ownsIntroduction.current)) {
          introduced = ownsIntroduction.current = true;
          setArtwork(artwork);
        }
        if (active) setSettled(true);
      })
      .catch(() => {
        // A missing introduction leaves the static mark visible.
        if (active) {
          introduced = true;
          setSettled(true);
        }
      });
    return () => {
      active = false;
      request.abort();
    };
  }, [animate, variant]);
  useLayoutEffect(() => {
    // The document policy permits style APIs while refusing style attributes in inserted markup.
    for (const part of artwork?.styles ?? []) {
      const node = element.current?.querySelector<SVGElement>(`[id="${part.id}"]`);
      if (node) node.style.cssText = part.value;
    }
  }, [artwork]);
  return (
    <span
      ref={element}
      className="rio-brand"
      data-variant={variant}
      data-size={size === 'large' ? 'large' : undefined}
      data-pending={pending || undefined}
      data-introduce={artwork ? 'true' : undefined}
      role="img"
      aria-label={t({ id: 'brand.riosoma', message: 'Riosoma' })}
      style={{ '--rio-brand-mask': `url("/brand/riosoma-${variant}-mask.svg")` } as CSSProperties}
    >
      {artwork ? (
        <span className="rio-brand__art" dangerouslySetInnerHTML={{ __html: artwork.markup }} />
      ) : (
        <span className="rio-brand__mask" />
      )}
    </span>
  );
}
