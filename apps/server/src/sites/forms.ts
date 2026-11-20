import {
  AppError,
  FieldSpec,
  defaultCellValue,
  unanswered,
  visibleFormQuestions,
  type PublicQuestion,
} from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { clientAddress } from '../authorization/store.js';
import { dataStore } from '../data/context.js';
import type { StoredField } from '../data/types.js';
import { admitSubmission, publicDefinition, submitAnswers } from '../data/public-forms.js';
import { allowCheckout } from './headers.js';
import { documentHtml, escape, words } from './render.js';
import { invalid, SITE_LIMITS } from './reads.js';
import { lockLiveSite, unavailable, type LiveSite } from './store.js';
import { lockServingDomain, publicLink } from '../custom-domains/store.js';
import { decodeSiteAnswers } from './form-values.js';
import { pictureSizeReader, readLogoSize } from './media.js';
import { demoReadOnly, demoRequest } from '../demo/boundary.js';

/**
 * A form without scripts leaves out its cascade questions, so a cascade question can't be one the
 * form requires, and its field can't have a Required rule that refuses every submission without it.
 */
export function requireSiteQuestions(
  questions: readonly PublicQuestion[],
  fields: readonly StoredField[],
): void {
  const cascades = questions.filter((question) => question.options.cascade);
  if (cascades.some((question) => question.required))
    throw new AppError('validation_failed', 'data.select.siteRequiredCascade');
  const byId = new Map(fields.map((field) => [field.id, field]));
  if (
    cascades.some((question) => {
      const field = byId.get(question.fieldId);
      return (
        (field?.type === 'singleSelect' || field?.type === 'multipleSelect') &&
        Boolean(field.options.validation?.required)
      );
    })
  )
    throw new AppError('validation_failed', 'data.select.siteRuledCascade');
}

function control(question: PublicQuestion, active = true, row?: string): string {
  const name = escape(question.fieldId);
  const label = ` aria-label="${row === undefined ? escape(question.label) : words('lineColumn', { name: question.label, line: row })}"`;
  const spec = FieldSpec.safeParse({ type: question.type, options: question.options });
  const defaultValue = spec.success
    ? defaultCellValue(spec.data, { now: new Date(), userId: null })
    : undefined;
  const required = `${active ? '' : ' disabled'}${question.required && unanswered(defaultValue) ? ' data-site-required' : ''}${active && question.required && unanswered(defaultValue) ? ' required' : ''}`;
  if (question.type === 'multiCurrency')
    return `<label>${words('amount')}<input name="${name}.amount" type="number" step="any"${question.options.allowNegative === false ? ' min="0"' : ''}${required}></label><label>${words('currency')}<select name="${name}.code"${active ? '' : ' disabled'}>${Intl.supportedValuesOf(
      'currency',
    )
      .map(
        (code) =>
          `<option value="${code}"${code === question.options.code ? ' selected' : ''}>${code}</option>`,
      )
      .join('')}</select></label>`;
  if (question.type === 'lineItems') {
    // The static page carries the same plus glyph as the shared icon library.
    const columns = question.options.columns as Array<{
      id: string;
      name: string;
      type: PublicQuestion['type'];
      options: Record<string, unknown>;
    }>;
    const line = (index: string, number: string) =>
      `<fieldset data-site-line><legend>${words('line', { line: number })}</legend>${columns.map((column) => `<label>${escape(column.name)}${control({ fieldId: `${question.fieldId}.${index}.${column.id}`, label: column.name, type: column.type, options: column.options, help: '', required: false }, active, number)}</label>`).join('')}</fieldset>`;
    return `<div data-site-lines>${line('0', '1')}</div><template data-site-line-template>${line('__index__', '__number__')}</template><button type="button" data-site-add-line aria-label="${words('addLine')}" title="${words('addLine')}"${active ? '' : ' disabled'}><svg aria-hidden="true" focusable="false" viewBox="0 0 448 512" width="1em" height="1em"><path fill="currentColor" d="M256 64c0-17.7-14.3-32-32-32s-32 14.3-32 32l0 160-160 0c-17.7 0-32 14.3-32 32s14.3 32 32 32l160 0 0 160c0 17.7 14.3 32 32 32s32-14.3 32-32l0-160 160 0c17.7 0 32-14.3 32-32s-14.3-32-32-32l-160 0 0-160z"></path></svg></button>`;
  }
  if (question.type === 'singleSelect' || question.type === 'multipleSelect') {
    const choices = question.options.choices as Array<{ id: string; name: string }>;
    return `<select name="${name}"${label}${required}${question.type === 'multipleSelect' ? ' multiple' : ''}><option value=""></option>${choices.map((choice) => `<option value="${escape(choice.id)}">${escape(choice.name)}</option>`).join('')}</select>`;
  }
  if (question.type === 'longText' || question.type === 'json')
    return `<textarea name="${name}"${label}${required} maxlength="10000"></textarea>`;
  if (question.type === 'location')
    return `<label>${words('latitude')}<input name="${name}.lat" type="number" min="-90" max="90" step="any"${required}></label><label>${words('longitude')}<input name="${name}.lng" type="number" min="-180" max="180" step="any"${required}></label>`;
  if (question.type === 'dateRange') {
    const type = question.options.includeTime ? 'datetime-local' : 'date';
    return `<label>${words('start')}<input name="${name}.start" type="${type}"${required}></label><label>${words('end')}<input name="${name}.end" type="${type}"${required}></label>${question.options.includeTime ? `<p>${words('utc')}</p>` : ''}`;
  }
  const numeric = ['number', 'currency', 'percent', 'duration', 'rating'].includes(question.type);
  const type = numeric
    ? 'number'
    : question.type === 'checkbox'
      ? 'checkbox'
      : question.type === 'email'
        ? 'email'
        : question.type === 'url'
          ? 'url'
          : question.type === 'date'
            ? question.options.includeTime
              ? 'datetime-local'
              : 'date'
            : 'text';
  // A box checked by default starts checked, since an unchecked box is always an answer here.
  const checked =
    question.type === 'checkbox' &&
    (question.options.defaultValue as { value?: unknown } | undefined)?.value === true
      ? ' checked'
      : '';
  return `<input name="${name}"${label} type="${type}"${numeric ? ' step="any"' : ''}${required}${checked}>${question.type === 'date' && question.options.includeTime ? `<p>${words('utc')}</p>` : ''}`;
}

function siteFormAction(live: LiveSite, parts: string[]) {
  const page = live.pages.find((item) => item.id === parts[1]);
  const block = page?.blocks.find((item) => item.id === parts[2]);
  if (parts.length !== 3 || block?.kind !== 'button' || block.action.kind !== 'form') unavailable();
  return block.action;
}

export async function serveForm(
  request: FastifyRequest,
  reply: FastifyReply,
  live: LiveSite,
  parts: string[],
  base: string,
  origin: string,
) {
  const action = siteFormAction(live, parts);
  if (request.method === 'POST') await live.scope.require(live.row.database_id, 'editRecords');
  const { pool, schemas } = dataStore(request.server.ctx);
  const linked = await query<{ id: string }>(
    pool,
    sql`SELECT f.id FROM ${ident(schemas.app, 'public_forms')} f
    JOIN ${ident(schemas.app, 'views')} v ON v.id = f.view_id
    WHERE f.view_id = ${action.viewId} AND v.table_id = ${action.tableId}
      AND f.database_id = ${live.row.database_id} AND f.stopped_at IS NULL`,
  );
  const formId = linked.rows[0]?.id ?? unavailable();
  const form = await publicDefinition(request.server.ctx, formId, requireSiteQuestions);
  const allowPayment = !request.server.ctx.config.demoMode;
  if (request.method === 'POST' && form.payment && !allowPayment) throw demoReadOnly();
  if (form.payment) allowCheckout(request);
  const questions = form.questions.filter((question) => !question.options.cascade);
  const path = `${base}/${parts.join('/')}`;
  const defaults = Object.fromEntries(
    questions.flatMap((question) => {
      const spec = FieldSpec.safeParse({ type: question.type, options: question.options });
      const value = spec.success ? defaultCellValue(spec.data, { now: new Date(), userId: null }) : undefined;
      return value === undefined ? [] : [[question.fieldId, value]];
    }),
  );
  const initial = decodeSiteAnswers(
    questions,
    new URLSearchParams(
      questions
        .filter((question) => question.type === 'checkbox' && defaults[question.fieldId] === true)
        .map((question): [string, string] => [question.fieldId, 'on']),
    ),
  );
  const visible = new Set(
    visibleFormQuestions(questions, { ...defaults, ...initial }).map((question) => question.fieldId),
  );
  const definition = escape(JSON.stringify({ questions, defaults }));
  let body = `<p>${escape(form.description)}</p><form data-site-form="${definition}" data-site-required-message="${words('required')}" method="post" action="${path}"><input type="hidden" name="ticket" value="${escape(form.ticket)}"><label class="site-trap">${words('website')}<input name="website" tabindex="-1" autocomplete="off"></label>${questions.map((question) => `<fieldset data-site-question="${escape(question.fieldId)}"${visible.has(question.fieldId) ? '' : ' hidden'}><legend>${escape(question.label)}</legend>${control(question, visible.has(question.fieldId))}<p>${escape(question.help)}</p></fieldset>`).join('')}<button>${escape(form.submitLabel) || words('submit')}</button></form>`;
  if (request.method === 'POST') {
    let editPath: string | undefined;
    let checkoutUrl: string | undefined;
    if (typeof request.body !== 'string' || Buffer.byteLength(request.body) > 64 * 1024) invalid();
    const values = new URLSearchParams(request.body);
    if (!values.get('website')) {
      // The same checks as the form's own page, with an IPv6 visitor counted by their /64.
      await admitSubmission(
        request.server.ctx,
        formId,
        values.get('ticket') ?? '',
        clientAddress(request.ip),
        reply,
      );
      const decoded = decodeSiteAnswers(questions, values);
      const shown = visibleFormQuestions(questions, { ...defaults, ...decoded });
      const answers = Object.fromEntries(
        shown
          .filter((question) => Object.hasOwn(decoded, question.fieldId))
          .map((question) => [question.fieldId, decoded[question.fieldId]]),
      );
      const submitted = await submitAnswers(request.server.ctx, formId, answers, undefined, {
        allowPayment,
        authorize: async (db, currentForm) => {
          if (request.customDomain)
            await lockServingDomain(request.server.ctx, db, request.customDomain, 'sites');
          // AccessScope caches roles, so the locked check needs the site's current publisher and a fresh scope.
          const current = await lockLiveSite(db, schemas, live.row.slug, request.customDomain?.id);
          const currentAction = siteFormAction(current, parts);
          if (
            current.row.database_id !== currentForm.databaseId ||
            currentAction.tableId !== currentForm.tableId ||
            currentAction.viewId !== currentForm.viewId
          )
            unavailable();
          await current.scope.require(current.row.database_id, 'editRecords');
        },
      });
      if (submitted.editLink) {
        const link = await publicLink(request.server.ctx, live.row.org_id, 'forms', submitted.editLink);
        editPath = 'url' in link && typeof link.url === 'string' ? link.url : link.path;
      }
      // Deliver the private edit link before leaving for checkout.
      if (submitted.checkoutUrl && !editPath) return reply.redirect(submitted.checkoutUrl, 303);
      checkoutUrl = submitted.checkoutUrl;
    }
    body = `<p>${escape(form.thankYou) || words('thankYou')}</p>${editPath ? `<p><a href="${escape(editPath)}">${words('editResponse')}</a></p>` : ''}${checkoutUrl ? `<p><a href="${escape(checkoutUrl)}">${words('continuePayment')}</a></p>` : ''}`;
  }
  const readSize = () =>
    readLogoSize(pool, schemas, live, pictureSizeReader(pool, schemas, request.server.ctx.config));
  // Allowing a site answer must not let confirmation rendering download remote logo bytes.
  const logoSize = await (request.server.ctx.config.demoMode ? demoRequest(readSize) : readSize());
  const html = documentHtml(
    live.settings,
    base,
    origin,
    form.title,
    form.description,
    path,
    body,
    undefined,
    true,
    logoSize,
  );
  if (Buffer.byteLength(html) > SITE_LIMITS.bytes) throw new AppError('payload_too_large', 'errors.tooLarge');
  return reply.type('text/html; charset=utf-8').send(html);
}
