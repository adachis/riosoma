import { Menu, MenuItem, MenuTrigger } from '../../shell/menu';
import { faCloudArrowDown, faFileArrowUp, faPlus, faTrashCan } from '@fortawesome/free-solid-svg-icons';
import type { MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import { IMPORT_PLATFORMS, type DatabaseSummary, type ImportPlatform } from '@riosoma/contracts';
import { Banner, Button, Heading, Spinner } from '@riosoma/ui';
import { useMinuteClock } from '../../relative-time';
import { DatabaseCard } from './DatabaseCard';
import { HomeList } from './HomeList';
import { navigateOnPlainClick } from '../database/shell/navigation';
import './home.css';

/** The tools the import menu offers, by the names they go by everywhere */
const TOOLS: Readonly<Record<ImportPlatform, MessageDescriptor>> = {
  nocodb: msg({ id: 'import.platform.tool.nocodb', message: 'NocoDB' }),
  baserow: msg({ id: 'import.platform.tool.baserow', message: 'Baserow' }),
  grist: msg({ id: 'import.platform.tool.grist', message: 'Grist' }),
  teable: msg({ id: 'import.platform.tool.teable', message: 'Teable' }),
  seatable: msg({ id: 'import.platform.tool.seatable', message: 'SeaTable' }),
  clickup: msg({ id: 'import.platform.tool.clickup', message: 'ClickUp' }),
  asana: msg({ id: 'import.platform.tool.asana', message: 'Asana' }),
  notion: msg({ id: 'import.platform.tool.notion', message: 'Notion' }),
  monday: msg({ id: 'import.platform.tool.monday', message: 'monday.com' }),
  smartsheet: msg({ id: 'import.platform.tool.smartsheet', message: 'Smartsheet' }),
};

export interface DatabaseListProps {
  databases: DatabaseSummary[];
  grouped?: boolean;
  onMove?(database: DatabaseSummary): void;
  hrefFor(id: string): string;
  onOpen(id: string): void;
  onCreate?(): void;
  onPreload?(action: 'create' | 'file' | 'airtable' | 'platform' | 'trash'): void;
  /** Offers starting a database from a CSV or Excel file */
  onImport?(): void;
  /** Offers bringing a whole base across from Airtable */
  onImportAirtable?(): void;
  /** Offers bringing a whole base across from NocoDB, Baserow, Grist, Teable, or SeaTable */
  onImportPlatform?(platform: ImportPlatform): void;
  /** Opens the deleted databases */
  onTrash?(): void;
  onFavorite?(database: DatabaseSummary): void;
  onDelete?(database: DatabaseSummary): void;
  onDuplicate?(database: DatabaseSummary): void;
  favoritePending?: string;
  loading: boolean;
  /** Keeps creation controls in place while the initial home layout settles. */
  actionsDisabled?: boolean;
  error?: string;
  demoEmpty?: boolean;
  onOpenShared?(): void;
}

export function DatabaseList({
  databases,
  grouped = true,
  onMove,
  hrefFor,
  onOpen,
  onCreate,
  onPreload,
  onImport,
  onImportAirtable,
  onImportPlatform,
  onTrash,
  onFavorite,
  favoritePending,
  onDelete,
  onDuplicate,
  loading,
  actionsDisabled = false,
  error,
  demoEmpty = false,
  onOpenShared,
}: DatabaseListProps) {
  const { t, i18n } = useLingui();
  const now = useMinuteClock();
  const empty = !loading && !error && databases.length === 0;
  const favorites = databases.filter((database) => database.favorite);
  const recent = databases
    .filter(
      (database) =>
        !database.favorite && database.openedAt && Date.parse(database.openedAt) >= now - 30 * 86_400_000,
    )
    .sort((a, b) => b.openedAt!.localeCompare(a.openedAt!))
    .slice(0, 8);
  const sections = [
    ...(grouped && favorites.length
      ? [{ title: t({ id: 'home.favorites', message: 'Favorites' }), databases: favorites }]
      : []),
    ...(grouped && recent.length
      ? [{ title: t({ id: 'home.recent', message: 'Recent' }), databases: recent }]
      : []),
    { title: t({ id: 'home.all', message: 'All databases' }), databases },
  ];
  // Starting from a file and starting from nothing are different jobs, so they never share an icon.
  // With no databases yet there is room to say what each one does, and the main choice comes first.
  const fromFile = (labeled: boolean) =>
    onImport ? (
      <Button
        icon={faFileArrowUp}
        onPress={onImport}
        isDisabled={actionsDisabled}
        onHoverStart={() => onPreload?.('file')}
        onFocus={() => onPreload?.('file')}
        aria-label={t({ id: 'import.newDatabaseFile', message: 'New database from a CSV or Excel file' })}
      >
        {labeled ? <Trans id="import.newDatabaseFile.short">From a CSV or Excel file</Trans> : null}
      </Button>
    ) : null;
  const fromNothing = (labeled: boolean) =>
    onCreate ? (
      <Button
        variant="primary"
        icon={faPlus}
        onPress={onCreate}
        isDisabled={actionsDisabled}
        onHoverStart={() => onPreload?.('create')}
        onFocus={() => onPreload?.('create')}
        aria-label={t({ id: 'home.new', message: 'New database' })}
      >
        {labeled ? <Trans id="home.new">New database</Trans> : null}
      </Button>
    ) : null;
  const fromElsewhere = (
    <>
      {onImportAirtable ? (
        <Button
          icon={faCloudArrowDown}
          onPress={onImportAirtable}
          isDisabled={actionsDisabled}
          onHoverStart={() => onPreload?.('airtable')}
          onFocus={() => onPreload?.('airtable')}
        >
          <Trans id="import.airtable.menu">Import from Airtable</Trans>
        </Button>
      ) : null}
      {onImportPlatform ? (
        <MenuTrigger>
          <Button
            icon={faCloudArrowDown}
            isDisabled={actionsDisabled}
            onHoverStart={() => onPreload?.('platform')}
            onFocus={() => onPreload?.('platform')}
          >
            <Trans id="import.platform.menu">Import from another tool</Trans>
          </Button>
          <Menu
            aria-label={t({ id: 'import.platform.menu', message: 'Import from another tool' })}
            onAction={(key) => onImportPlatform(key as ImportPlatform)}
          >
            {IMPORT_PLATFORMS.map((platform) => (
              <MenuItem key={platform} id={platform}>
                {i18n._(TOOLS[platform])}
              </MenuItem>
            ))}
          </Menu>
        </MenuTrigger>
      ) : null}
    </>
  );
  const create =
    empty && !demoEmpty ? (
      <div className="rio-database-list__actions">
        {fromNothing(true)}
        {fromFile(true)}
        {fromElsewhere}
      </div>
    ) : (
      <div className="rio-database-list__actions">
        {fromFile(false)}
        {fromElsewhere}
        {fromNothing(false)}
      </div>
    );
  return (
    <section className="rio-database-list">
      <div className="rio-database-list__header">
        <Heading level={1}>
          <Trans id="home.title">Databases</Trans>
        </Heading>
        <div className="rio-database-list__header-actions">
          {/* Always offered, so someone who deleted their only database can get it back. */}
          {onTrash && (
            <Button
              variant="quiet"
              icon={faTrashCan}
              onPress={onTrash}
              onHoverStart={() => onPreload?.('trash')}
              onFocus={() => onPreload?.('trash')}
            >
              <Trans id="trash.open">Trash</Trans>
            </Button>
          )}
          {empty && !demoEmpty ? null : create}
        </div>
      </div>
      {error ? <Banner tone="danger">{error}</Banner> : null}
      {loading ? (
        <div aria-busy="true" aria-label={t({ id: 'home.loading', message: 'Loading databases' })}>
          <Spinner label={t({ id: 'home.loading', message: 'Loading databases' })} size="sm" />
          <div className="rio-database-list__grid" aria-hidden="true">
            {Array.from({ length: 6 }, (_, index) => (
              <div key={index} className="rio-database-card rio-database-card--placeholder">
                <span className="rio-database-icon" />
                <span className="rio-database-card__placeholder-line" />
              </div>
            ))}
          </div>
        </div>
      ) : empty ? (
        <div className="rio-database-list__empty">
          <Heading>
            {demoEmpty ? (
              <Trans id="demo.home.empty.title">Nothing here in the demo</Trans>
            ) : (
              <Trans id="home.empty.title">No databases yet</Trans>
            )}
          </Heading>
          {demoEmpty ? (
            <p>
              <Trans id="demo.home.empty.body">Explore the demo databases in Shared with me.</Trans>{' '}
              <a
                href="/home/shared"
                onClick={onOpenShared ? (event) => navigateOnPlainClick(event, onOpenShared) : undefined}
              >
                <Trans id="home.shared">Shared with me</Trans>
              </a>
            </p>
          ) : (
            create
          )}
        </div>
      ) : (
        sections.map((section) => {
          const grid = (
            <HomeList items={section.databases} className="rio-database-list__grid" label={section.title}>
              {(database) => (
                <li key={database.id}>
                  <DatabaseCard
                    database={database}
                    onMove={onMove ? () => onMove(database) : undefined}
                    href={hrefFor(database.id)}
                    onOpen={() => onOpen(database.id)}
                    onFavorite={onFavorite ? () => onFavorite(database) : undefined}
                    favoritePending={favoritePending === database.id}
                    onDelete={onDelete ? () => onDelete(database) : undefined}
                    onDuplicate={onDuplicate ? () => onDuplicate(database) : undefined}
                  />
                </li>
              )}
            </HomeList>
          );
          // With nothing starred or recent, "All databases" would only repeat the page title.
          return sections.length === 1 ? (
            <div key={section.title}>{grid}</div>
          ) : (
            <section key={section.title} aria-label={section.title}>
              <Heading level={2}>{section.title}</Heading>
              {grid}
            </section>
          );
        })
      )}
    </section>
  );
}
