import { Menu, MenuItem, MenuTrigger } from '../../shell/menu';
import { LazyBoundary, lazyFeature } from '../../shell/lazy';
const ShortcutMoveDialog = lazyFeature(() =>
  import('./ShortcutMoveDialog').then((module) => ({ default: module.ShortcutMoveDialog })),
);
import { HomeDragItem } from './HomeArrangement';
import { HomeList } from './HomeList';
import { useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import { type HomeAction, type HomeListing, type HomeShortcut } from '@riosoma/contracts';
import { Button } from '@riosoma/ui';
import { faArrowUpRightFromSquare, faEllipsis } from '@fortawesome/free-solid-svg-icons';
import { Icon } from '@riosoma/icons';
import { useNavigate } from '@tanstack/react-router';
import { navigateOnPlainClick } from '../database/shell/navigation';

export function Shortcuts({
  listing,
  parentId,
  section,
  change,
  pending,
}: {
  listing: HomeListing;
  parentId: string | null;
  section: string;
  change(action: HomeAction): void;
  pending: boolean;
}) {
  const { t } = useLingui();
  const navigate = useNavigate();
  const [moving, setMoving] = useState<HomeShortcut | null>(null);
  const [destination, setDestination] = useState('root');
  const items = (listing.shortcuts ?? []).filter((item) =>
    section === 'trash'
      ? item.trashed
      : !item.trashed && item.parentId === parentId && (section === 'my' || section === 'folder'),
  );
  return (
    <>
      <HomeList
        items={items}
        className="rio-home-files__folders"
        label={t({ id: 'home.shortcuts.title', message: 'Shortcuts' })}
      >
        {(item) => {
          const name = item.name ?? t({ id: 'home.shortcuts.unavailable', message: 'Unavailable shortcut' });
          return (
            <HomeDragItem key={item.id} id={item.id} name={name} as="li">
              {item.available && !item.trashed && item.href ? (
                <a
                  className="rio-home-shortcut"
                  href={item.href}
                  onClick={(event) =>
                    navigateOnPlainClick(event, () => {
                      void navigate({ to: item.href! });
                    })
                  }
                >
                  <Icon icon={faArrowUpRightFromSquare} />
                  <span>{name}</span>
                </a>
              ) : (
                <span>{name}</span>
              )}
              {item.owned ? (
                <MenuTrigger>
                  <Button
                    variant="quiet"
                    icon={faEllipsis}
                    aria-label={t({ id: 'home.shortcuts.more', message: `More for ${name}` })}
                  />
                  <Menu aria-label={name}>
                    {!item.trashed ? (
                      <MenuItem
                        onAction={() => {
                          setMoving(item);
                          setDestination(item.parentId ?? 'root');
                        }}
                      >
                        {t({ id: 'home.folders.move', message: 'Move to…' })}
                      </MenuItem>
                    ) : null}
                    {!item.trashed ? (
                      <MenuItem
                        isDisabled={pending}
                        onAction={() => change({ kind: 'shortcut.trash', shortcutId: item.id })}
                      >
                        {t({ id: 'home.folders.trash', message: 'Move to Trash' })}
                      </MenuItem>
                    ) : null}
                    {item.trashed && item.available ? (
                      <MenuItem
                        isDisabled={pending}
                        onAction={() => change({ kind: 'shortcut.restore', shortcutId: item.id })}
                      >
                        {t({ id: 'home.shortcuts.restore', message: 'Restore shortcut' })}
                      </MenuItem>
                    ) : null}
                  </Menu>
                </MenuTrigger>
              ) : null}
            </HomeDragItem>
          );
        }}
      </HomeList>
      {moving && (
        <LazyBoundary size="dialog" onDismiss={() => setMoving(null)}>
          <ShortcutMoveDialog
            moving={moving}
            listing={listing}
            destination={destination}
            onDestination={setDestination}
            onClose={() => setMoving(null)}
            change={change}
            pending={pending}
          />
        </LazyBoundary>
      )}
    </>
  );
}
