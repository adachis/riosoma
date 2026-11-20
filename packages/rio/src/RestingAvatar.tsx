import { useLingui } from '@lingui/react/macro';
import { mascotUrl } from './mascot';
import './RestingAvatar.css';

/** The shell paints the companion before it needs any moving poses. */
export function RestingAvatar({ size }: { size: number }) {
  const { t } = useLingui();
  const mood = t({ id: 'rio.mood.idle', message: 'idle' });
  return (
    <span
      className="rio-avatar rio-avatar--resting"
      data-mood="idle"
      data-small={size <= 48}
      style={{ inlineSize: size, blockSize: size }}
    >
      <svg
        viewBox="-110 -90 810 810"
        width={size}
        height={size}
        role="img"
        aria-label={t({ id: 'rio.avatar.label', message: `Rio, ${mood}` })}
      >
        <ellipse cx="155" cy="672" rx="130" ry="14" fill="var(--rio-text)" opacity=".12" />
        <use href={`${mascotUrl}#resting`} />
      </svg>
    </span>
  );
}
