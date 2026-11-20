import {
  faArrowRightFromBracket,
  faCircleQuestion,
  faCommentDots,
  faHouse,
  faLanguage,
  faLayerGroup,
  faPlus,
  faSitemap,
  faSwatchbook,
  faTrashCan,
  faUsers,
} from '@fortawesome/free-solid-svg-icons';
import { useLingui } from '@lingui/react/macro';
import { IMPORT_PLATFORMS } from '@riosoma/contracts';
import type { IconDefinition } from '@riosoma/icons';
import { useNavigate } from '@tanstack/react-router';
import { useMemo } from 'react';
import type { FeatureId, PlaceKey } from '../levels/features';
import { placeWords } from '../levels/palette';

export interface PaletteCommand {
  id: string;
  label: string;
  icon: IconDefinition;
  run(): void;
  /** The feature the command opens, when experience levels tidy it away elsewhere */
  feature?: FeatureId;
  /** The registered entry the command stands in for, whose words it carries */
  place?: PlaceKey;
  /** Features wait for a query, so the first list stays short.  Commands are always listed. */
  group?: 'commands' | 'features';
}

export interface PaletteCommandOptions {
  demo?: boolean;
  /** Managing people is for an organization's owner and the members it gives that role to. */
  canManagePeople: boolean;
  /** Personal access tokens are for everyone with an account of their own, so not for guests. */
  canUseTokens: boolean;
  /** Guests cannot create or import databases. */
  canCreateDatabases?: boolean;
  /**
   * Organizational units are for their admins, and before the first one exists, for whoever may
   * make it.  The command waits for a query, so units show nowhere until someone looks for them.
   */
  canOpenUnits?: boolean;
  /** Help opens over whatever page the person is on, which only the shell can do. */
  onOpenHelp(topic?: string): void;
  /** Feedback is sent from wherever the person is, so the shell opens it too. */
  onSendFeedback?(): void;
  onSignOut(): void;
}

/**
 * What the palette can do rather than open.  Every destination goes through the router, so the
 * address still says where the person is and the back button still works; the two commands that
 * belong to the shell call back into it.
 */
export function usePaletteCommands({
  demo = false,
  canManagePeople,
  canUseTokens,
  canCreateDatabases = true,
  canOpenUnits = false,
  onOpenHelp,
  onSendFeedback,
  onSignOut,
}: PaletteCommandOptions): PaletteCommand[] {
  const { t, i18n } = useLingui();
  const navigate = useNavigate();
  return useMemo(() => {
    // Commands for registered entries take their words from the registry, as every screen's do.
    const words = (place: PlaceKey) => placeWords(i18n, place);
    const commands: PaletteCommand[] = [
      {
        id: 'home',
        label: t({ id: 'palette.cmd.home', message: 'Go home' }),
        icon: faHouse,
        run: () => {
          void navigate({ to: '/' });
        },
      },
      {
        id: 'newDatabase',
        label: t({ id: 'palette.cmd.newDatabase', message: 'New database' }),
        icon: faPlus,
        // Home owns the dialog; it reads the ask out of the address and clears it again.
        run: () => {
          void navigate({ to: '/', search: { new: 'database' } });
        },
      },
      {
        id: 'import',
        ...words('home:import'),
        run: () => {
          void navigate({ to: '/', search: { new: 'import' } });
        },
      },
      {
        id: 'importAirtable',
        ...words('home:importAirtable'),
        run: () => {
          void navigate({ to: '/', search: { new: 'airtable' } });
        },
      },
      ...IMPORT_PLATFORMS.map((platform) => ({
        id: `import${platform[0]!.toUpperCase()}${platform.slice(1)}`,
        ...words(`home:import.${platform}`),
        run: () => {
          void navigate({ to: '/', search: { new: platform } });
        },
      })),
      {
        id: 'trash',
        label: t({ id: 'palette.cmd.trash', message: 'Open the trash' }),
        icon: faTrashCan,
        run: () => {
          void navigate({ to: '/', search: { trash: '1' } });
        },
      },
      {
        id: 'appearance',
        label: t({ id: 'palette.cmd.appearance', message: 'Change theme and color scheme' }),
        icon: faSwatchbook,
        run: () => {
          if (demo) void navigate({ to: '/', search: { appearance: '1' } });
          else void navigate({ to: '/settings/$section', params: { section: 'appearance' } });
        },
      },
      {
        id: 'language',
        label: t({ id: 'palette.cmd.language', message: 'Change language' }),
        icon: faLanguage,
        run: () => {
          void navigate({ to: '/settings/$section', params: { section: 'language' } });
        },
      },
      {
        id: 'levels',
        label: t({ id: 'palette.cmd.levels', message: 'Change experience level' }),
        icon: faLayerGroup,
        run: () => {
          if (demo) void navigate({ to: '/', search: { appearance: '1' } });
          else void navigate({ to: '/settings/$section', params: { section: 'levels' } });
        },
      },
      {
        id: 'api',
        group: 'features',
        ...words('palette:api'),
        run: () => onOpenHelp('rest-api'),
      },
      {
        id: 'mcp',
        group: 'features',
        ...words('palette:mcp'),
        run: () => onOpenHelp('mcp'),
      },
    ];
    // Settings has no tokens page for a guest, so the palette offers none either.
    if (canUseTokens)
      commands.splice(
        commands.findIndex((command) => command.id === 'api'),
        0,
        {
          id: 'tokens',
          group: 'features',
          ...words('settings:tokens'),
          run: () => {
            void navigate({ to: '/settings/$section', params: { section: 'tokens' } });
          },
        },
      );
    if (canManagePeople)
      commands.push({
        id: 'people',
        label: t({ id: 'palette.cmd.people', message: 'Manage people' }),
        icon: faUsers,
        run: () => {
          void navigate({ to: '/settings/$section', params: { section: 'people' } });
        },
      });
    if (canOpenUnits)
      commands.push({
        id: 'orgUnits',
        group: 'features',
        label: t({ id: 'palette.cmd.orgUnits', message: 'Organizational units' }),
        icon: faSitemap,
        run: () => {
          void navigate({ to: '/settings/$section', params: { section: 'org-units' } });
        },
      });
    commands.push({
      id: 'help',
      label: t({ id: 'palette.cmd.help', message: 'Open help' }),
      icon: faCircleQuestion,
      run: () => onOpenHelp(),
    });
    if (onSendFeedback)
      commands.push({
        id: 'feedback',
        label: t({ id: 'palette.cmd.feedback', message: 'Send feedback' }),
        icon: faCommentDots,
        run: onSendFeedback,
      });
    commands.push({
      id: 'signOut',
      label: t({ id: 'palette.cmd.signOut', message: 'Sign out' }),
      icon: faArrowRightFromBracket,
      run: onSignOut,
    });
    const available = canCreateDatabases
      ? commands
      : commands.filter((command) => command.id !== 'newDatabase' && !command.id.startsWith('import'));
    return demo
      ? available.filter((command) => !['signOut', 'api', 'mcp', 'language', 'feedback'].includes(command.id))
      : available;
  }, [
    demo,
    t,
    i18n,
    navigate,
    canManagePeople,
    canUseTokens,
    canCreateDatabases,
    canOpenUnits,
    onOpenHelp,
    onSendFeedback,
    onSignOut,
  ]);
}
