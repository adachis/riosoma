import { randomBytes } from 'node:crypto';
import {
  AppError,
  PAYMENT_CURRENCIES,
  PaymentSettings,
  PAYMENT_STATES,
  jsonEqual,
  newId,
  paymentDecimals,
  type PaymentState,
} from '@riosoma/contracts';
import { ident, query, sql, type Queryable, type Sql } from '@riosoma/db';
import type { AppContext } from '../app.js';
import { applyCommand, parseCommand } from '../data/commands/index.js';
import { recordChange } from '../data/commands/transaction.js';
import type { CommandContext } from '../data/commands/context.js';
import type { DataSchemas } from '../data/context.js';
import { managedGrant, managedRefused, type ManagedGrant } from '../data/managed.js';
import { loadFields } from '../data/metadata.js';
import { currentValues } from '../data/physical/records.js';
import type { StoredField } from '../data/types.js';
import { seal } from '../secrets.js';
import { unsealCredential } from '../credentials/service.js';
import { amountFor, minorUnits, refused, unavailable } from './stripe.js';

export interface ConnectionRow {
  id: string;
  org_id: string;
  secret_key: string;
  webhook_secret: string;
  live: boolean;
  enabled: boolean;
}
export interface PaymentRow {
  record_id: string;
  org_id: string;
  /** Null once the database, table, or person is gone for good, while the payment's history stays */
  database_id: string | null;
  table_id: string | null;
  owner_id: string | null;
  connection_id: string;
  target_id: string;
  kind: 'form' | 'booking';
  description: string;
  amount: number;
  currency: string;
  state: PaymentState;
  session_id: string | null;
  intent_id: string | null;
  checkout_url: string | null;
  expires_at: Date;
  address_key: string | null;
  booking_mail: string | null;
  mail_claimed: boolean;
}
interface ResultFields {
  status_field: string;
  amount_field: string;
  reference_field: string;
  choices: Record<PaymentState, string>;
}

/** How long a Checkout Session stays open, which Stripe allows from 30 minutes */
export const CHECKOUT_SECONDS = 1800;
/**
 * A pending booking holds its place until Stripe says its Checkout Session expired or completed.
 * A payment made just before the session closes can be confirmed late, so the hold outlasts the
 * session.  Only when that word never comes does the hold end on its own, this long after expiry.
 */
export const HOLD_FALLBACK_SECONDS = 3600;

/** Whether the payment under this alias keeps its record's booking in place: paid, or still open */
export function holding(alias: string): Sql {
  const p = (column: string) => ident(alias, column);
  return sql`(${p('state')} = 'paid' OR (${p('state')} = 'pending'
    AND ${p('expires_at')} > statement_timestamp() - make_interval(secs => ${HOLD_FALLBACK_SECONDS})))`;
}

/** Whether a pending payment's hold has ended on its own, without word from Stripe */
export function holdLapsed(payment: Pick<PaymentRow, 'state' | 'expires_at'>, now = Date.now()): boolean {
  return payment.state !== 'pending' || payment.expires_at.getTime() + HOLD_FALLBACK_SECONDS * 1000 <= now;
}

export function secretContext(id: string, part: 'key' | 'webhook'): string {
  return `stripe:${id}:${part}`;
}
export async function connectionKey(
  ctx: AppContext,
  connection: ConnectionRow,
  db?: Queryable,
): Promise<string> {
  return unsealCredential(
    ctx.config.secretKey,
    connection.secret_key,
    secretContext(connection.id, 'key'),
    connection.org_id,
    db,
  );
}
export async function activeConnection(db: Queryable, schemas: DataSchemas, orgId: string) {
  return (
    await query<ConnectionRow>(
      db,
      sql`SELECT * FROM ${ident(schemas.app, 'stripe_connections')} WHERE org_id = ${orgId} AND enabled`,
    )
  ).rows[0];
}
export async function paymentAudit(
  db: Queryable,
  schemas: DataSchemas,
  orgId: string | null,
  actorId: string | null,
  action: string,
  metadata: Record<string, unknown> = {},
) {
  await query(
    db,
    sql`INSERT INTO ${ident(schemas.audit, 'events')} (org_id, actor_id, action, metadata) VALUES (${orgId}, ${actorId}, ${`payments.${action}`}, ${JSON.stringify(metadata)}::jsonb)`,
  );
}
export async function pageSettings(
  db: Queryable,
  schemas: DataSchemas,
  targetId: string,
): Promise<PaymentSettings | null> {
  const row = (
    await query<{ settings: unknown }>(
      db,
      sql`SELECT settings FROM ${ident(schemas.app, 'payment_pages')} WHERE target_id = ${targetId}`,
    )
  ).rows[0];
  return row ? PaymentSettings.parse(row.settings) : null;
}

/** The questions whose answers decide what a page charges: its price's option and its quantity */
export function priceFields(settings: PaymentSettings | null): Set<string> {
  const ids = new Set<string>();
  if (settings?.price.kind === 'option') ids.add(settings.price.fieldId);
  if (settings?.quantityFieldId) ids.add(settings.quantityFieldId);
  return ids;
}

/**
 * The answers that set what a record was charged.  A page prices a record once, when it reserves
 * the payment, so from then on these stay as they were priced, whatever the payment's state.
 * Empty for a record no page charged for.
 */
export async function pricedAnswers(
  db: Queryable,
  schemas: DataSchemas,
  recordId: string,
): Promise<Set<string>> {
  const payment = (
    await query<{ target_id: string }>(
      db,
      sql`SELECT target_id FROM ${ident(schemas.app, 'payments')} WHERE record_id = ${recordId}`,
    )
  ).rows[0];
  return priceFields(payment ? await pageSettings(db, schemas, payment.target_id) : null);
}

/**
 * Throws when an edit through a form's link changes an answer its record was priced by.  The
 * edit sends every visible answer back, so one that still matches what is stored passes.
 */
export async function refusePricedChanges(
  c: CommandContext,
  tableId: string,
  fields: readonly StoredField[],
  rows: ReadonlyArray<{ id: string; values: Record<string, unknown> }>,
) {
  for (const row of rows) {
    const priced = await pricedAnswers(c.db, c.schemas, row.id);
    const named = fields.filter((field) => priced.has(field.id) && Object.hasOwn(row.values, field.id));
    if (!named.length) continue;
    const stored = (await currentValues(c.db, c.schemas.data, tableId, named, [row.id])).get(row.id);
    for (const field of named)
      if (!jsonEqual(row.values[field.id] ?? null, stored?.[field.id] ?? null))
        throw new AppError('forbidden', 'payments.answersLocked', { params: { fieldId: field.id } });
  }
}

/** Stripe's smallest charge in a currency as a price would read, such as 0.50 */
export function minimumText(currency: keyof typeof PAYMENT_CURRENCIES): string {
  const decimals = paymentDecimals(currency);
  return (PAYMENT_CURRENCIES[currency] / 10 ** decimals).toFixed(decimals);
}

/** Every price a page can charge, one at a time, has to reach the currency's minimum. */
function requireMinimum(settings: PaymentSettings, price: string): void {
  if (minorUnits(price, settings.currency) >= PAYMENT_CURRENCIES[settings.currency]) return;
  throw new AppError('validation_failed', 'payments.belowMinimum', {
    params: { currency: settings.currency.toUpperCase(), minimum: minimumText(settings.currency) },
  });
}

export async function validateSettings(
  c: CommandContext,
  tableId: string,
  settings: PaymentSettings,
  asked: Set<string>,
) {
  const fields = await loadFields(c.db, c.schemas, [tableId]);
  if (settings.price.kind === 'fixed') requireMinimum(settings, settings.price.amount);
  else {
    const price = settings.price;
    const field = fields.find((field) => field.id === price.fieldId);
    if (!field || field.type !== 'singleSelect' || !asked.has(field.id) || !field.options.choices.length)
      throw refused();
    const choices = field.options.choices;
    if (Object.keys(price.amounts).length !== choices.length) throw refused();
    for (const choice of choices) {
      const amount = price.amounts[choice.id];
      if (!amount) throw refused();
      requireMinimum(settings, amount);
    }
  }
  if (settings.quantityFieldId) {
    const quantity = fields.find((field) => field.id === settings.quantityFieldId);
    if (!quantity || quantity.type !== 'number' || !asked.has(quantity.id)) throw refused();
  }
}

async function storedResultFields(
  db: Queryable,
  schemas: DataSchemas,
  tableId: string,
  currency: string,
): Promise<ResultFields | undefined> {
  return (
    await query<ResultFields>(
      db,
      sql`SELECT * FROM ${ident(schemas.app, 'payment_fields')} WHERE table_id = ${tableId} AND currency = ${currency}`,
    )
  ).rows[0];
}

/** The result fields for a currency, added and marked managed the first time a page asks for them. */
export async function resultFields(
  c: CommandContext,
  tableId: string,
  currency: string,
): Promise<ResultFields> {
  const existing = await storedResultFields(c.db, c.schemas, tableId, currency);
  if (existing) return existing;
  const choices = Object.fromEntries(
    PAYMENT_STATES.map((state) => [state, newId('choice')]),
  ) as ResultFields['choices'];
  const status = newId('field');
  const amount = newId('field');
  const reference = newId('field');
  const names = await loadFields(c.db, c.schemas, [tableId]);
  const unusedName = (name: string) => {
    let candidate = name;
    let suffix = 2;
    while (names.some((field) => field.name === candidate)) candidate = `${name} ${suffix++}`;
    return candidate;
  };
  const { paymentNames } = await import('./words.js');
  const fields = [
    {
      id: status,
      name: unusedName(paymentNames.status.message),
      type: 'singleSelect',
      options: {
        choices: PAYMENT_STATES.map((state) => ({
          id: choices[state],
          name: paymentNames[state].message,
          color: 'gray',
        })),
      },
    },
    {
      id: amount,
      name: unusedName(paymentNames.amount.message),
      type: 'currency',
      options: { code: currency.toUpperCase(), precision: paymentDecimals(currency) },
    },
    { id: reference, name: unusedName(paymentNames.reference.message), type: 'text' },
  ];
  for (const field of fields) {
    const command = parseCommand({
      id: newId('command'),
      groupId: newId('action'),
      kind: 'field.create',
      tableId,
      field,
    });
    await recordChange(c, await applyCommand(c, command), {
      commandId: command.id,
      groupId: command.groupId,
      clientId: null,
      system: true,
    });
  }
  // From here on only the payment service writes these fields, and no one changes their definitions.
  await query(
    c.db,
    sql`UPDATE ${ident(c.schemas.app, 'fields')} SET managed = 'payment' WHERE id = ANY(${[status, amount, reference]}::text[])`,
  );
  await query(
    c.db,
    sql`INSERT INTO ${ident(c.schemas.app, 'payment_fields')} (table_id, currency, status_field, amount_field, reference_field, choices) VALUES (${tableId}, ${currency}, ${status}, ${amount}, ${reference}, ${JSON.stringify(choices)}::jsonb)`,
  );
  return { status_field: status, amount_field: amount, reference_field: reference, choices };
}

/** The values a payment's state gives its record's result fields, with the grant to write exactly those */
export async function paymentValues(
  db: Queryable,
  schemas: DataSchemas,
  payment: Pick<PaymentRow, 'record_id' | 'table_id' | 'currency' | 'amount'>,
  state: PaymentState,
  reference: string | null,
): Promise<{ values: Record<string, unknown>; grant: ManagedGrant }> {
  const fields = payment.table_id
    ? await storedResultFields(db, schemas, payment.table_id, payment.currency)
    : undefined;
  if (!fields) throw unavailable();
  const values = {
    [fields.status_field]: fields.choices[state],
    [fields.amount_field]:
      state === 'paid' || state === 'refunded' ? payment.amount / 10 ** paymentDecimals(payment.currency) : 0,
    [fields.reference_field]: reference,
  };
  return { values, grant: managedGrant([payment.record_id], Object.keys(values)) };
}

/** Throws when a visitor's answers name any payment result field, in any currency. */
export async function refuseResultValues(
  c: CommandContext,
  tableId: string,
  values: Record<string, unknown>,
) {
  const managed = new Set(
    (await loadFields(c.db, c.schemas, [tableId])).filter((field) => field.managed).map((field) => field.id),
  );
  if (Object.keys(values).some((id) => managed.has(id))) throw managedRefused();
}

export interface Reservation {
  payment: PaymentRow;
  /** The visitor's answers with the Pending result values added */
  values: Record<string, unknown>;
  /** Permission to write exactly those result fields in exactly this record */
  grant: ManagedGrant;
}

/**
 * Records a pending payment for a page's new record.  The reservation commits before any request
 * to Stripe, so an early webhook always finds its record.  Answers that name a payment result
 * field are refused before the Pending values are added, whatever their currency.
 */
export async function reservePayment(
  c: CommandContext,
  target: { id: string; kind: 'form' | 'booking' },
  tableId: string,
  recordId: string,
  description: string,
  values: Record<string, unknown>,
  addressKey: string | null = null,
): Promise<Reservation | null> {
  const settings = await pageSettings(c.db, c.schemas, target.id);
  if (!settings) return null;
  await refuseResultValues(c, tableId, values);
  await query(
    c.db,
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${c.schemas.app}:stripe:${c.actor.orgId}`}, 0))`,
  );
  // Settings can come in from an organization archive without a Stripe account, so a page that
  // charges refuses answers until one is connected, and never takes them free.
  const connection = await activeConnection(c.db, c.schemas, c.actor.orgId);
  if (!connection) throw new AppError('unavailable', 'payments.notConnected');
  const amount = amountFor(settings, values);
  const expires = new Date((Math.ceil(Date.now() / 1000) + CHECKOUT_SECONDS) * 1000);
  const payment = (
    await query<PaymentRow>(
      c.db,
      sql`INSERT INTO ${ident(c.schemas.app, 'payments')} (record_id, org_id, database_id, table_id, owner_id, connection_id, target_id, kind, description, amount, currency, expires_at, address_key) VALUES (${recordId}, ${c.actor.orgId}, ${c.databaseId}, ${tableId}, ${c.actor.userId || null}, ${connection.id}, ${target.id}, ${target.kind}, ${description}, ${amount}, ${settings.currency}, ${expires.toISOString()}::timestamptz, ${addressKey}) RETURNING *`,
    )
  ).rows[0]!;
  const pending = await paymentValues(c.db, c.schemas, payment, 'pending', null);
  return { payment, values: { ...values, ...pending.values }, grant: pending.grant };
}

export const newConnectionId = () => randomBytes(24).toString('hex');
export function sealBookingMail(ctx: AppContext, recordId: string, mail: unknown): string {
  return seal(ctx.config.secretKey, JSON.stringify(mail), `payment-mail:${recordId}`);
}
