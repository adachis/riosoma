import { useLingui } from '@lingui/react/macro';
import {
  faArrowRightFromBracket,
  faCircleQuestion,
  faCommentDots,
  faGear,
  faKeyboard,
  faPalette,
} from '@fortawesome/free-solid-svg-icons';
import { Menu, MenuItem, MenuSeparator } from './menu';
import type { PersonalMenuProps } from './PersonalMenu';

export function PersonalMenuItems({
  user,
  demo,
  onSettings,
  onAppearance,
  onShortcuts,
  onHelp,
  onFeedback,
  onSignOut,
}: PersonalMenuProps) {
  const { t } = useLingui();
  const label = t({ id: 'shell.personalMenu', message: 'Personal menu' });
  return (
    <Menu aria-label={label}>
      <MenuItem id="identity" isDisabled description={user.email} textValue={user.name || user.email}>
        {user.name || user.email}
      </MenuItem>
      <MenuSeparator />
      {!demo && (
        <MenuItem id="settings" icon={faGear} onAction={onSettings}>
          {t({ id: 'shell.nav.settings', message: 'Settings' })}
        </MenuItem>
      )}
      <MenuItem id="appearance" icon={faPalette} onAction={onAppearance}>
        {t({ id: 'settings.nav.appearance', message: 'Appearance' })}
      </MenuItem>
      <MenuItem id="shortcuts" icon={faKeyboard} onAction={onShortcuts}>
        {t({ id: 'shortcuts.title', message: 'Keyboard shortcuts' })}
      </MenuItem>
      <MenuItem id="help" icon={faCircleQuestion} onAction={onHelp}>
        {t({ id: 'shell.help', message: 'Help' })}
      </MenuItem>
      {!demo && (
        <MenuItem id="feedback" icon={faCommentDots} onAction={onFeedback}>
          {t({ id: 'shell.helpMenu.feedback', message: 'Send feedback' })}
        </MenuItem>
      )}
      <MenuSeparator />
      {!demo && (
        <MenuItem id="signOut" icon={faArrowRightFromBracket} onAction={onSignOut}>
          {t({ id: 'shell.signOut', message: 'Sign out' })}
        </MenuItem>
      )}
    </Menu>
  );
}
