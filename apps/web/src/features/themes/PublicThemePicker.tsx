import { useLingui } from '@lingui/react/macro';
import type { ThemePick } from '@riosoma/contracts';
import type { AnchorProps } from '../../demos/anchors';
import { ThemePicker } from './ThemePicker';

/**
 * The theme a public form, view link, or booking page shows in, picked in its share or publish
 * settings.  It wins over the database's own theme on the public page.  No pick follows the
 * database: its forced theme if it has one, and the default otherwise.
 */
export function PublicThemePicker({
  value,
  onChange,
  isDisabled = false,
  anchorProps,
}: {
  value: ThemePick | null;
  onChange(next: ThemePick | null): void;
  isDisabled?: boolean;
  /** Help's name for the picker, as `anchor()` makes it */
  anchorProps: AnchorProps;
}) {
  const { t } = useLingui();
  return (
    <ThemePicker
      value={value}
      onChange={onChange}
      isDisabled={isDisabled}
      anchorProps={anchorProps}
      label={t({ id: 'publicTheme.label', message: 'Page theme' })}
      inheritLabel={t({ id: 'publicTheme.inherit', message: 'Same as the database' })}
      description={t({
        id: 'publicTheme.help',
        message: 'How the page looks to everyone who opens it, in place of the database’s theme.',
      })}
      blockedNote={t({
        id: 'publicTheme.blocked',
        message:
          'Your organization doesn’t allow this theme anymore, so the page shows in the database’s theme or the organization’s default instead.',
      })}
    />
  );
}
