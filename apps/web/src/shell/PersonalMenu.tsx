import { useLingui } from '@lingui/react/macro';
import type { SessionInfo } from '@riosoma/contracts';
import { Avatar, avatarInitials, Button } from '@riosoma/ui';
import { MenuTrigger } from './menu';
import { lazyFeature, LazyBoundary } from './lazy';

const PersonalMenuItems = lazyFeature(() =>
  import('./PersonalMenuItems').then((module) => ({ default: module.PersonalMenuItems })),
);

export interface PersonalMenuProps {
  demo?: boolean;
  user: SessionInfo['user'];
  signingOut: boolean;
  onSettings(): void;
  onAppearance(): void;
  onShortcuts(): void;
  onHelp(): void;
  onFeedback(): void;
  onSignOut(): void;
}

export function PersonalMenu(props: PersonalMenuProps) {
  const { user, signingOut } = props;
  const { t, i18n } = useLingui();
  const menu = t({ id: 'shell.personalMenu', message: 'Personal menu' });
  const initials = avatarInitials(user.name || user.email, i18n.locale);
  const label = t({ id: 'shell.personalMenu.initials', message: `${initials}: ${menu}` });
  return (
    <MenuTrigger>
      <Button
        className="rio-personal-menu__trigger"
        variant="quiet"
        size="sm"
        primaryAction
        tooltip
        aria-label={label}
        data-personal-menu-trigger
        isDisabled={signingOut}
        onHoverStart={() => PersonalMenuItems.preload()}
        onFocus={() => PersonalMenuItems.preload()}
      >
        <Avatar name={user.name || user.email} color="blue" size="sm" />
      </Button>
      <LazyBoundary size="controls">
        <PersonalMenuItems {...props} />
      </LazyBoundary>
    </MenuTrigger>
  );
}
