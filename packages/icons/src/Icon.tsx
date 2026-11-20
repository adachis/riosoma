import type { IconDefinition } from '@fortawesome/fontawesome-common-types';

/**
 * Renders a Font Awesome Free icon as inline SVG.  Icons are imported by name from the Font
 * Awesome packages, so the bundle carries only the ones in use and nothing loads from a CDN.
 */
export interface IconProps {
  icon: IconDefinition;
  /** Any CSS length; defaults to the shared icon size token. */
  size?: string;
  /** Accessible name.  Leave it off for decorative icons next to visible text. */
  label?: string;
  className?: string;
}

export function Icon({ icon, size, label, className }: IconProps) {
  const [width, height, , , pathData] = icon.icon;
  const paths = Array.isArray(pathData) ? pathData : [pathData];
  return (
    <svg
      className={className ? `rio-icon ${className}` : 'rio-icon'}
      viewBox={`0 0 ${width} ${height}`}
      width="1em"
      height="1em"
      style={{ fontSize: size ?? 'var(--rio-icon-size)' }}
      focusable="false"
      {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}
    >
      {paths.map((d) => (
        <path key={d.slice(0, 24)} d={d} fill="currentColor" />
      ))}
    </svg>
  );
}
