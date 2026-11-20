import { MENTION_PATTERN, OFFICE_LIMITS, type RowData } from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import type pg from 'pg';
import type { AccessScope } from '../../access.js';
import type { CommentRow } from '../../comments.js';
import type { DataSchemas } from '../../context.js';
import type { FileStorageConfig } from '../../files/storage.js';
import { relationContext, type FormatContext } from '../../format.js';
import type { StoredField, StoredTable } from '../../types.js';
import { documentValue, valueLine } from './cells.js';
import { OFFICE_COPY, say } from './copy.js';
import { fieldFiles, isPicture, loadImage, type DocumentImage, type ImageSource } from './images.js';
import { madeAt } from './view.js';
import { wordWriter } from './load.js';
import type { WordComment, WordRecordField } from './word.js';

/**
 * One record as a Word document: its primary field as the title, then every field the person can
 * see in the record card's order, each as a label and its value, with the record's images under
 * their field and, when asked for, its comments.  Attachments are named whether or not they're
 * pictures, so a file that can't be drawn is still there by name.
 */

export interface RecordDocumentOptions {
  pool: pg.Pool;
  schemas: DataSchemas;
  scope: AccessScope;
  table: StoredTable;
  /** The fields the person can see, in the table's order, which is the record card's */
  fields: readonly StoredField[];
  row: RowData;
  locale: string;
  timeZone: string;
  comments: boolean;
  files: FileStorageConfig;
  now: Date;
}

/** Images are drawn at most this wide or tall, in pixels, which is sharp on a printed page */
const IMAGE_EDGE = 1_400;

/** A comment's mentions as the names they stand for, in their current spelling where it's known. */
function commentText(body: string, context: FormatContext): string {
  return body.replace(
    MENTION_PATTERN,
    (_, name: string, id: string) => `@${context.people.get(id)?.name ?? name}`,
  );
}

async function recordComments(
  options: RecordDocumentOptions,
  context: FormatContext,
): Promise<WordComment[]> {
  const { pool, schemas, table, row, scope } = options;
  const result = await query<CommentRow>(
    pool,
    sql`SELECT * FROM ${ident(schemas.app, 'comments')}
      WHERE org_id = ${scope.actor.orgId} AND database_id = ${table.databaseId}
        AND table_id = ${table.id} AND record_id = ${row.id} AND deleted_at IS NULL
      ORDER BY created_at, id`,
  );
  const fields = new Map(options.fields.map((field) => [field.id, field]));
  return result.rows
    .filter((comment) => !comment.field_id || fields.has(comment.field_id))
    .map((comment) => {
      const time = madeAt(comment.created_at, options.locale, options.timeZone);
      return {
        author:
          (comment.author_id && context.people.get(comment.author_id)?.name) ||
          say(OFFICE_COPY.someone, options.locale),
        when: comment.edited_at ? `${time} (${say(OFFICE_COPY.edited, options.locale)})` : time,
        body: [
          comment.field_id ? fields.get(comment.field_id)?.name : null,
          commentText(comment.body, context),
        ]
          .filter(Boolean)
          .join('\n'),
      };
    });
}

export async function recordWord(options: RecordDocumentOptions): Promise<{ bytes: Buffer; title: string }> {
  const { pool, schemas, scope, table, fields, row, locale } = options;
  await scope.requireUse(table.databaseId, 'export', { tableId: table.id });
  const relations = await relationContext({
    db: pool,
    schemas,
    table,
    scope,
    fields,
    rows: [row],
    names: true,
  });
  const context: FormatContext = { locale, timeZone: options.timeZone, ...relations };
  const byId = new Map(fields.map((field) => [field.id, field]));
  const primary = fields.find((field) => field.id === table.primaryFieldId);
  const title =
    (primary ? valueLine(documentValue(primary, row, byId, context)).trim() : '') ||
    say(OFFICE_COPY.untitled, locale);
  const images: ImageSource = { db: pool, appSchema: schemas.app, files: options.files, table };
  let drawn = 0;
  let pictures = 0;
  const shown: WordRecordField[] = [];
  for (const field of fields) {
    const drawnHere: DocumentImage[] = [];
    for (const file of (await fieldFiles(images, field, row)).filter(isPicture)) {
      pictures += 1;
      if (drawn >= OFFICE_LIMITS.recordImages) continue;
      const image = await loadImage(images, file, IMAGE_EDGE);
      if (!image) continue;
      drawn += 1;
      drawnHere.push(image);
    }
    shown.push({ label: field.name, value: documentValue(field, row, byId, context), images: drawnHere });
  }
  const word = await wordWriter();
  const bytes = await word.recordDocument({
    title,
    lines: [
      say(OFFICE_COPY.recordSource, locale, {
        table: table.name,
        time: madeAt(options.now, locale, options.timeZone),
      }),
    ],
    fields: shown,
    note:
      pictures > OFFICE_LIMITS.recordImages
        ? say(OFFICE_COPY.imagesCapped, locale, { shown: OFFICE_LIMITS.recordImages, total: pictures })
        : null,
    comments: options.comments
      ? {
          heading: say(OFFICE_COPY.comments, locale),
          empty: say(OFFICE_COPY.noComments, locale),
          items: await recordComments(options, context),
        }
      : null,
    paper: word.paperFor(locale),
    pageLabel: say(OFFICE_COPY.page, locale, { page: word.PAGE_SLOT, count: word.PAGES_SLOT }),
  });
  return { bytes, title };
}
