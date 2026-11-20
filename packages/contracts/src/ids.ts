/**
 * Stable identifiers.  Every object gets a short type prefix plus 14 random base-62 characters,
 * so an ID says what it points at and never changes when the object is renamed.
 */
export const ID_PREFIXES = {
  signatureRequest: 'sgr',
  signatureSigner: 'sgn',
  org: 'org',
  orgUnit: 'oun',
  user: 'usr',
  group: 'grp',
  session: 'ses',
  invitation: 'inv',
  folder: 'fol',
  shortcut: 'sct',
  tag: 'tag',
  tagColor: 'tcl',
  database: 'db',
  table: 'tbl',
  field: 'fld',
  namedFunction: 'fnc',
  view: 'viw',
  record: 'rec',
  choice: 'cho',
  /** One change request; the server applies each command ID at most once */
  command: 'cmd',
  /** Commands a person made as one action, undone together */
  action: 'act',
  /** One open browser tab or other connected client */
  client: 'cli',
  comment: 'cmt',
  dashboard: 'dsh',
  automation: 'aut',
  interface: 'itf',
  /** JavaScript saved with a database, run by hand from its script panel */
  script: 'scr',
  attachment: 'att',
  token: 'tok',
  source: 'src',
  job: 'job',
  audit: 'aud',
  notification: 'ntf',
  webhook: 'whk',
  /** One call to a webhook, the same on every attempt */
  delivery: 'dlv',
  passkey: 'pky',
  /** A saved copy of a database, taken by hand or on a schedule */
  snapshot: 'snp',
  /** A database an organization saved for anyone in it to start from */
  template: 'tpl',
  /** A scheduled report */
  report: 'rpt',
  /** A view's rows kept as a copy in an outside system */
  outboundSync: 'osy',
  /** Something a person told the organization's admins: a problem, an idea, or a question */
  feedback: 'fbk',
  /** An admin's answer to a piece of feedback */
  feedbackReply: 'fbr',
  /** A record rule: which records the roles and people it names see */
  recordRule: 'rul',
  /** A person's private address for a view, which calendar apps subscribe to */
  calendarFeed: 'cfd',
  /** One booking made through a booking page, which its cancel link names */
  booking: 'bkg',
  /** A person's account at a cloud drive, connected to add attachments from it */
  connection: 'cnx',
  /** A recurring job Rio carries out on a schedule as the person who set it up */
  routine: 'rtn',
  /** One trip through a routine */
  routineRun: 'rtr',
  /** Something a routine's run left for its owner to approve */
  routineApproval: 'rta',
} as const;

export type IdKind = keyof typeof ID_PREFIXES;
export type IdPrefix = (typeof ID_PREFIXES)[IdKind];

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const RANDOM_LENGTH = 14;

/** Creates a new identifier for the given kind, using the platform's secure random source. */
export function newId(kind: IdKind): string {
  const bytes = new Uint8Array(RANDOM_LENGTH);
  globalThis.crypto.getRandomValues(bytes);
  let out: string = ID_PREFIXES[kind];
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return out;
}

const ID_PATTERN = /^([a-z]{2,3})([0-9A-Za-z]{14})$/;

/** Returns the kind an identifier belongs to, or null when it isn't a Riosoma identifier. */
export function idKind(id: string): IdKind | null {
  const m = ID_PATTERN.exec(id);
  if (!m) return null;
  const prefix = m[1];
  for (const [kind, p] of Object.entries(ID_PREFIXES)) {
    if (p === prefix) return kind as IdKind;
  }
  return null;
}

/** True when the value is an identifier of the given kind. */
export function isId(value: unknown, kind: IdKind): value is string {
  return typeof value === 'string' && idKind(value) === kind;
}
