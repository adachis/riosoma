import { useLingui } from '@lingui/react/macro';
import type { ChoiceColor } from '@riosoma/contracts';
import { Focusable } from 'react-aria-components';
import { useContext } from 'react';
import { Avatar, PersonDirectory, type AvatarSize } from './Avatar';
import { Tooltip, TooltipTrigger } from './Tooltip';
import { cx } from './cx';
import './AvatarStack.css';

/** One person in the stack.  The name is already translated by the caller. */
export interface AvatarStackPerson {
  id: string;
  name: string;
  color: ChoiceColor;
  pictureUrl?: string | null;
  deactivated?: boolean;
}

export interface AvatarStackProps {
  people: AvatarStackPerson[];
  /** How many avatars show before the rest collapse into the "+N" chip.  Defaults to 4. */
  max?: number;
  size?: AvatarSize;
  className?: string;
}

/** Four avatars and a chip still fit a column of the grid; more than that stops saying anything. */
const DEFAULT_MAX = 4;

/** Like the segmenters in `Avatar`: one formatter per locale, built once and kept. */
const listFormats = new Map<string, Intl.ListFormat>();

/** Names in the locale's own list style, so a name that holds a comma cannot split in two. */
function listOf(names: string[], locale: string): string {
  let format = listFormats.get(locale);
  if (format == null) {
    format = new Intl.ListFormat(locale, { type: 'conjunction' });
    listFormats.set(locale, format);
  }
  return format.format(names);
}

/**
 * The people on a record, as overlapping avatars with a chip for everyone who did not fit.  Each
 * avatar is named by its person and each name has a tooltip, so nothing is hidden behind the
 * overlap.  The stack's width comes from the number of items it shows alone — every item is a
 * circle of a fixed size — so a longer name never moves the columns around it.
 */
export function AvatarStack({ people, max = DEFAULT_MAX, size = 'md', className }: AvatarStackProps) {
  const { t, i18n } = useLingui();
  const directory = useContext(PersonDirectory);
  const label = (person: AvatarStackPerson) => {
    const current = directory.get(person.id);
    const name = current?.name ?? person.name;
    return (current?.deactivated ?? person.deactivated)
      ? t({ id: 'ui.avatar.deactivated', message: `${name} (deactivated)` })
      : name;
  };
  const shown = people.slice(0, Math.max(0, Math.floor(max)));
  const hidden = people.slice(shown.length);
  const count = hidden.length;
  const names = listOf(hidden.map(label), i18n.locale);
  // The chip draws a count, but its name carries every name behind it, so nobody has to open the
  // tooltip to hear who is in the stack.
  const moreLabel = t({ id: 'ui.avatarStack.more', message: `${count} more: ${names}` });
  const moreCount = t({ id: 'ui.avatarStack.moreCount', message: `+${count}` });
  return (
    <span className={cx('rio-avatar-stack', className)} data-size={size}>
      {shown.map((person) => (
        <TooltipTrigger key={person.id}>
          {/* Out of the tab order, as a clipped pill's label is: the name is the avatar's accessible
              name already, so the tooltip is a convenience for the pointer. */}
          <Focusable excludeFromTabOrder>
            <Avatar
              className="rio-avatar-stack__item"
              personId={person.id}
              pictureUrl={person.pictureUrl}
              deactivated={person.deactivated}
              name={person.name}
              color={person.color}
              size={size}
            />
          </Focusable>
          <Tooltip>{label(person)}</Tooltip>
        </TooltipTrigger>
      ))}
      {hidden.length === 0 ? null : (
        <TooltipTrigger>
          <Focusable excludeFromTabOrder>
            <span className="rio-avatar-stack__item rio-avatar-stack__more" role="img" aria-label={moreLabel}>
              {moreCount}
            </span>
          </Focusable>
          <Tooltip>
            <ul className="rio-avatar-stack__names">
              {hidden.map((person) => (
                <li key={person.id}>{label(person)}</li>
              ))}
            </ul>
          </Tooltip>
        </TooltipTrigger>
      )}
    </span>
  );
}
