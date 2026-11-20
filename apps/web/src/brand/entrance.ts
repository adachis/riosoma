import { trustedHTML } from '../security/trusted-types';
import './entrance.css';

export async function loadArtwork(variant: 'lockup' | 'wordmark' | 'mascot', signal: AbortSignal) {
  const response = await fetch(`/brand/riosoma-${variant}.svg`, { signal });
  if (!response.ok) throw new Error();
  const source = await response.text();
  const styles: { id: string; value: string }[] = [];
  // Detached documents enforce the policy too, so styles leave the trusted art before parsing.
  const inertSource = source.replace(/<[^>]+>/g, (tag) => {
    const style = /\sstyle="([^"]*)"/.exec(tag);
    if (!style) return tag;
    const id = /\sid="([^"]+)"/.exec(tag)?.[1];
    if (!id) throw new Error();
    styles.push({ id, value: style[1]! });
    return tag.replace(style[0], '');
  });
  const doc = new DOMParser().parseFromString(trustedHTML(inertSource), 'image/svg+xml');
  doc.querySelector('title')?.remove();
  const svg = doc.documentElement;
  svg.removeAttribute('role');
  svg.removeAttribute('aria-label');
  svg.setAttribute('aria-hidden', 'true');
  return { markup: trustedHTML(new XMLSerializer().serializeToString(svg)), styles };
}
