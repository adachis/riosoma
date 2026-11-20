/**
 * Interface anchors: stable names for the controls help explains, set as `data-anchor` on each
 * one.  Help modules name them in their front matter, and "Show me" demos point at them.
 *
 * Every anchor says what pressing it, or typing into it, would do, and the demo runner reads the
 * same marks from the page:
 * - `persists`: it saves, sends, deletes, or publishes something, so a demo may point at it but
 *   never press it or type into it
 * - `external`: it leaves Riosoma, with the same rule.  So does a control that leaves the page a
 *   demo is playing on, such as a link to another screen, since a demo can't put a page back
 * - `items`: what choosing one of the menu's or list's items does, `local` when an item only
 *   changes what's on screen and `persist` when it saves something, so demos only point at them
 *
 * One item of a menu whose others save can be anchored on its own, so a demo may press the item
 * that only opens something.  An anchor on an item says what pressing that item does.
 *
 * An anchor with no marks only opens, shows, or changes something on screen, and anything it
 * changes in a database lands in the demo's sandbox.
 */
export interface AnchorInfo {
  persists?: true;
  external?: true;
  items?: 'local' | 'persist';
}

const preloaders = new WeakMap<HTMLElement, () => Promise<unknown>>();

/** A demo waits for the same feature code that hover or keyboard focus requests. */
export function registerAnchorPreload(element: HTMLElement, preload: () => Promise<unknown>): () => void {
  preloaders.set(element, preload);
  return () => {
    if (preloaders.get(element) === preload) preloaders.delete(element);
  };
}

export async function preloadAnchor(element: HTMLElement): Promise<void> {
  await preloaders.get(element)?.();
}

export const ANCHORS = {
  'sources.app.choose': { items: 'local' },
  'sources.app.settings': {},
  'sources.app.key': {},
  'sources.app.createKey': { external: true },
  'sources.app.test': {},
  'sync.history': {},
  'settings.memories': {},
  'settings.knowledge': {},
  'settings.classification': {},
  'settings.retention': {},
  'settings.source.drivers': {},
  'settings.organization.appearance': {},

  'settings.profile': {},
  'settings.rio': {},
  'settings.appearance': {},
  'settings.levels': {},
  'settings.celebrations': {},
  'settings.notifications': {},
  'settings.reports': {},
  'settings.security': {},
  'settings.connected.accounts': {},
  'settings.connected.apps': {},
  'settings.oauth.apps': {},
  'settings.mcp': {},
  'settings.tokens': {},
  'settings.people': {},
  'settings.audit': {},
  'settings.org.units': {},
  'settings.sso': {},
  'settings.scim': {},
  'settings.sign.in.policy': {},
  'settings.credential.vaults': {},
  'settings.files': {},
  'settings.calendar.feeds': {},
  'settings.public.sharing': {},
  'settings.sources': {},
  'settings.snapshots': {},
  'settings.export.and.import': {},
  'settings.custom.domains': {},
  'settings.ai': {},
  'settings.updates': {},
  'settings.telemetry': {},
  'settings.feedback': {},
  'settings.my.feedback': {},
  'view.settings.grid': {},
  'view.settings.kanban': {},
  'view.settings.gallery': {},
  'view.settings.calendar': {},
  'view.settings.timeline': {},
  'view.settings.gantt': {},
  'view.settings.chart': {},
  'view.settings.pivot': {},
  'view.settings.list': {},
  'view.settings.map': {},
  'view.settings.form': {},
  'view.settings.orgChart': {},

  'sources.connection': {},
  'shareView.dialog': {},
  'share.dialog': {},
  'field.editor': {},
  'import.dialog': {},

  'ai.key': {},
  'ai.key.remove': { persists: true },
  'ai.key.replace': {},
  'ai.providers': {},
  'ai.test': { persists: true, external: true },
  'ai.test.unverified': {},
  'auth.signIn': {},
  'automation.canvas': {},
  'automation.steps': {},
  'automations.step.studioFlow': {},
  'dashboard.designer': {},
  'interface.designer': {},
  'joined.setup': {},
  'knowledge.databaseMemories': {},
  'knowledge.embeddings': {},
  'knowledge.myMemories': {},
  'knowledge.similar': {},
  'knowledge.sources': {},
  'knowledge.webSearch': {},
  'libraries.database': {},
  'libraries.personal': {},
  'libraries.title': {},
  'oauth.apps': {},
  'oauth.consent.title': {},
  'oauth.dynamic': {},
  'oauth.grants.all': {},
  'overrides.settings': {},
  'remote.title': {},
  'setup.database': {},
  'setup.owner': {},
  sources: {},
  'sources.drivers': {},
  'synced.fields': {},
  'synced.object': {},
  'synced.schedule': {},
  'synced.source': {},
  'view.color': {},
  'view.export': {},

  // The shell around every signed-in page
  'shell.home': { external: true },
  'shell.settings': { external: true },
  'notifications.open': {},
  'notifications.list': {},
  'notifications.read': { persists: true },
  'palette.open': {},
  'palette.query': {},
  // The palette's rows take someone to another screen or run a command, so a demo points at them.
  'palette.results': { external: true, items: 'persist' },

  // Settings
  'settings.language': {},
  'settings.appearance.theme': {},
  'settings.appearance.scheme': {},
  'branding.settings.logo': {},
  'settings.celebrations.level': {},
  'settings.celebrations.sounds': {},
  'settings.levels.level': {},

  // A database's sidebar and header
  'database.tables': {},
  // At the Simple level the button adds a blank table straight away, and above it opens a menu
  // whose items add or import one.
  'database.tables.add': { persists: true, items: 'persist' },
  // The open table's menu renames, which saves on Enter, and deletes.
  'database.table.menu': { items: 'persist' },
  // Three of its items only open a dialog, where saving, merging, and importing are steps of
  // their own, so a demo may press them on their own anchors.
  'database.table.recordAccess': {},
  'database.table.dedupe': {},
  'database.table.importInto': {},
  // Comparing records is only a question, and the search is a form's submit button, which a demo
  // never presses.
  'dedupe.field': {},
  'dedupe.search': {},
  'database.share': {},
  // The header's gear, whose items each open a dialog of their own.
  'database.menu': { items: 'local' },
  'database.menu.snapshots': {},
  'database.menu.theme': {},
  // The database's theme, which saves for everyone the moment one is chosen
  'database.theme.picker': { items: 'persist' },
  'database.trash': {},
  'automations.section': {},
  'automations.add': { persists: true },
  'dashboards.section': {},
  'dashboards.add': { persists: true },
  'interfaces.section': {},
  'interfaces.add': { persists: true },

  // A table's views and their controls
  'database.views': {},
  'database.views.add': { items: 'persist' },
  // The open view's menu renames and deletes, so a demo points at its items rather than choosing.
  'view.menu': { items: 'persist' },
  // Two of its items only open a dialog, so a demo may press them on their own anchors.
  'view.share': {},
  'view.reports': {},
  'view.syncOut': {},
  'view.toolbar': {},
  'view.hide': {},
  'view.filter': {},
  'view.filter.add': {},
  'view.sort': {},
  'view.sort.add': {},
  'view.group': {},
  'view.group.add': {},
  grid: {},
  // Set by the grid engine in `packages/grid-core`, which draws the button itself.
  'grid.field.add': {},
  // Set by a row's header cell, which opens the record at its own address.
  'grid.record.expand': { external: true },

  // The field dialog, whose fields are its own until it's saved
  'field.name': {},
  'field.type': { items: 'local' },
  'field.link.table': { items: 'local' },
  'field.link.multiple': {},
  'field.link.limit': { items: 'local' },
  'field.link.details': { items: 'local' },
  'field.formula.expression': {},
  'field.formula.suggestions': {},
  'database.namedFunctions': { external: true },
  'namedFunctions.create': { external: true },
  'namedFunctions.test': {},
  'field.create': { persists: true },

  // Sharing a database, where every choice saves at once
  'share.add': { items: 'persist' },
  'share.people': {},
  'share.role': { items: 'persist' },
  'share.everyone': { persists: true },

  // A view's public link, which publishing makes at once
  'shareView.help': {},
  'shareView.publish': { persists: true },
  'shareView.theme': { items: 'persist' },

  // A form's public link, whose page theme saves the moment one is chosen
  'forms.public.theme': { items: 'persist' },

  // A booking page's settings, which save only with the form
  'bookings.theme': { items: 'local' },

  // Importing a file, where the picker hands the file to the browser
  'import.file': { external: true },
  'import.start': { persists: true },

  // A view's scheduled reports, whose form saves only at the end
  'reports.add': {},
  'reports.form.name': {},
  'reports.form.format': {},
  'reports.form.frequency': {},
  'reports.form.save': { persists: true },

  // Setting up a Sync out, whose setup command runs only at the end
  'syncOut.add': {},
  'syncOut.setup.kind': {},
  'syncOut.setup.token': {},
  'syncOut.setup.start': { persists: true },

  // A table's record rules, which are drafts until they're saved
  'permissions.records.add': {},
  'permissions.records.who': {},
  'permissions.records.condition': {},
  'permissions.save': { persists: true },

  // The trash, where restoring is a change of its own
  'trash.list': {},

  // A database's snapshots
  'archives.snapshot.name': {},
  'archives.snapshot.take': { persists: true },

  // Rio
  'rio.open': {},
  'rio.input': {},
  'rio.send': { persists: true },
} as const satisfies Record<string, AnchorInfo>;

export type AnchorId = keyof typeof ANCHORS;

export function anchorInfo(id: string): AnchorInfo | undefined {
  return Object.hasOwn(ANCHORS, id) ? (ANCHORS as Record<string, AnchorInfo>)[id] : undefined;
}

export interface AnchorProps {
  'data-anchor': string;
  'data-persists'?: '';
  'data-external'?: '';
}

/** The attributes that name a control for help and mark what pressing it does. */
export function anchor(id: AnchorId): AnchorProps {
  const info: AnchorInfo = ANCHORS[id];
  return {
    'data-anchor': id,
    ...(info.persists ? { 'data-persists': '' as const } : {}),
    ...(info.external ? { 'data-external': '' as const } : {}),
  };
}
