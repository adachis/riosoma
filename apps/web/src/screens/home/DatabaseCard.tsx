import { Menu, MenuItem, MenuTrigger } from '../../shell/menu';
import { HomeDragItem } from './HomeArrangement';
import { TagPills } from './Tags';
import { useLingui } from '@lingui/react/macro';
import { roleAllows, type DatabaseSummary } from '@riosoma/contracts';
import { faEllipsis, faStar } from '@fortawesome/free-solid-svg-icons';
import { faStar as faEmptyStar } from '@fortawesome/free-regular-svg-icons';
import { Button, Text } from '@riosoma/ui';
import { useRelativeTime } from '../../relative-time';
import { navigateOnPlainClick } from '../database/shell/navigation';
import { DatabaseIcon } from './DatabaseIcon';
import './home.css';

export interface DatabaseCardProps {
  database: DatabaseSummary;
  href: string;
  onOpen(): void;
  onMove?(): void;
  onFavorite?(): void;
  favoritePending?: boolean;
  /** Offered to owners only: moves the database to the trash */
  onDelete?(): void;
  /** Offered to people who can change the database's schema: makes a copy of it */
  onDuplicate?(): void;
}

export function DatabaseCard({
  database,
  href,
  onOpen,
  onMove,
  onFavorite,
  favoritePending,
  onDelete,
  onDuplicate,
}: DatabaseCardProps) {
  const { t } = useLingui();
  const time = useRelativeTime(database.updatedAt);
  const canMove = onMove && database.role === 'owner';
  const canDelete = onDelete && database.role === 'owner';
  const canDuplicate = onDuplicate && roleAllows(database.role, 'editSchema');
  const menuLabel = t({ id: 'home.card.menu', message: `More for ${database.name}` });
  return (
    <HomeDragItem id={database.id} name={database.name} className="rio-database-card-wrap">
      <a className="rio-database-card" href={href} onClick={(event) => navigateOnPlainClick(event, onOpen)}>
        <DatabaseIcon database={database} />
        <span className="rio-database-card__text">
          <span className="rio-database-card__name">{database.name}</span>
          <Text variant="muted">
            <time dateTime={database.updatedAt}>{t({ id: 'home.updated', message: `Updated ${time}` })}</time>
          </Text>
          <TagPills resource={{ kind: 'database', id: database.id }} />
        </span>
      </a>
      {onFavorite || canDelete || canDuplicate || canMove ? (
        <div className="rio-database-card__actions">
          {onFavorite && (
            <Button
              variant="quiet"
              size="sm"
              icon={database.favorite ? faStar : faEmptyStar}
              aria-label={
                database.favorite
                  ? t({ id: 'home.favorite.remove', message: 'Remove from favorites' })
                  : t({ id: 'home.favorite.add', message: 'Add to favorites' })
              }
              aria-pressed={database.favorite}
              isPending={favoritePending}
              onPress={onFavorite}
            />
          )}
          {(canDelete || canDuplicate || canMove) && (
            <MenuTrigger>
              <Button variant="quiet" size="sm" icon={faEllipsis} aria-label={menuLabel} />
              <Menu aria-label={menuLabel}>
                {canMove ? (
                  <MenuItem onAction={onMove}>{t({ id: 'home.folders.move', message: 'Move to…' })}</MenuItem>
                ) : null}
                {canDuplicate ? (
                  <MenuItem onAction={onDuplicate}>
                    {t({ id: 'archives.duplicate.menu', message: 'Duplicate database' })}
                  </MenuItem>
                ) : null}
                {canDelete ? (
                  <MenuItem tone="danger" onAction={onDelete}>
                    {t({ id: 'home.card.delete', message: 'Delete database' })}
                  </MenuItem>
                ) : null}
              </Menu>
            </MenuTrigger>
          )}
        </div>
      ) : null}
    </HomeDragItem>
  );
}
