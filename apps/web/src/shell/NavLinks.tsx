import { useSession } from '../session';
import { Trans } from '@lingui/react/macro';
import { Link } from '@tanstack/react-router';
import { faGear, faHouse } from '@fortawesome/free-solid-svg-icons';
import { Icon } from '@riosoma/icons';
import { useHomeShortcutDrop } from '../screens/home/shortcuts';
import { anchor } from '../demos/anchors';

/** The app's destinations, shared by the sidebar and the phone menu. */
export function NavLinks({ onNavigate }: { onNavigate?: () => void }) {
  const homeDrop = useHomeShortcutDrop();
  const session = useSession();
  return (
    <ul className="rio-shell__nav">
      <li>
        <Link
          to="/"
          className="rio-shell__nav-item"
          activeOptions={{ exact: true }}
          onClick={onNavigate}
          {...anchor('shell.home')}
          {...homeDrop}
        >
          <Icon icon={faHouse} />
          <Trans id="shell.nav.home">Home</Trans>
        </Link>
      </li>
      {!session?.demo && (
        <li>
          <Link
            to="/settings/$section"
            params={{ section: 'appearance' }}
            className="rio-shell__nav-item"
            onClick={onNavigate}
            {...anchor('shell.settings')}
          >
            <Icon icon={faGear} />
            <Trans id="shell.nav.settings">Settings</Trans>
          </Link>
        </li>
      )}
    </ul>
  );
}
