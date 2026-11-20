import { useLingui } from '@lingui/react/macro';
import type { ChoiceColor } from '@riosoma/contracts';
import { createContext, useContext, useState } from 'react';
import { cx } from './cx';
import './Avatar.css';

/** `sm` is the size for a grid cell or a dense list, `md` the size for everywhere else. */
export type AvatarSize = 'sm' | 'md';

export interface AvatarProps extends Omit<React.HTMLAttributes<HTMLSpanElement>, 'children'> {
  /** The person's name, already translated by the caller. */
  name: string;
  personId?: string;
  pictureUrl?: string | null;
  deactivated?: boolean;
  color: ChoiceColor;
  size?: AvatarSize;
  className?: string;
}

export const PersonDirectory = createContext<
  ReadonlyMap<string, { name: string; email?: string; pictureUrl?: string | null; deactivated?: boolean }>
>(new Map());

/** Two initials at most: a third letter no longer fits a 24px circle. */
const MAX_INITIALS = 2;

const WHITESPACE = /\s+/;

/**
 * Segmenters are expensive to build and cheap to keep, and a grid draws one avatar per row, so
 * each locale gets a single segmenter for the lifetime of the page.
 */
const segmenters = new Map<string, Intl.Segmenter>();

function segmenter(locale: string): Intl.Segmenter | undefined {
  if (typeof Intl.Segmenter !== 'function') return undefined;
  const found = segmenters.get(locale);
  if (found != null) return found;
  const created = new Intl.Segmenter(locale, { granularity: 'word' });
  segmenters.set(locale, created);
  return created;
}

/** The words of a name by the locale's own rules, which is what decides where a word starts. */
function wordsOf(name: string, locale: string): string[] {
  const found = segmenter(locale);
  const words =
    found == null
      ? name.split(WHITESPACE)
      : Array.from(found.segment(name))
          .filter((part) => part.isWordLike)
          .map((part) => part.segment);
  // A name with nothing the locale counts as a word (a mark, a symbol) still gets its first letter.
  if (words.length === 0 && name.trim().length > 0) return [name.trim()];
  return words.filter((word) => word.length > 0);
}

/** The first letters of the first two words, uppercased the way the locale does it. */
export function avatarInitials(name: string, locale: string): string {
  return wordsOf(name, locale)
    .slice(0, MAX_INITIALS)
    .map((word) => Array.from(word)[0] ?? '')
    .join('')
    .toLocaleUpperCase(locale);
}

/**
 * A person, as their initials on the color that belongs to them.  The avatar is one image to
 * assistive technology and named by the initials and whole name, so the initials are a visual shorthand and
 * never the only place a name appears.  The caller's own DOM props pass through, which is what lets
 * an `AvatarStack` wrap an avatar in a tooltip trigger.
 */
export function Avatar({
  name: fallbackName,
  personId,
  pictureUrl,
  deactivated,
  color,
  size = 'md',
  className,
  ...rest
}: AvatarProps) {
  const { i18n, t } = useLingui();
  const person = useContext(PersonDirectory).get(personId ?? '');
  const name = person?.name ?? fallbackName;
  const url = person ? person.pictureUrl : pictureUrl;
  const [failed, setFailed] = useState<string>();
  const nameLabel =
    (person?.deactivated ?? deactivated)
      ? t({ id: 'ui.avatar.deactivated', message: `${name} (deactivated)` })
      : name;
  const initials = avatarInitials(name, i18n.locale);
  const hasPicture = url && url !== failed;
  const label = hasPicture
    ? nameLabel
    : t({ id: 'ui.avatar.initials', message: `${initials}: ${nameLabel}` });
  return (
    <span
      {...rest}
      className={cx('rio-person-avatar', className)}
      data-color={color}
      data-size={size}
      role="img"
      aria-label={label}
      data-deactivated={(person?.deactivated ?? deactivated) || undefined}
    >
      {hasPicture ? <img src={url} alt="" onError={() => setFailed(url)} /> : initials}
    </span>
  );
}
