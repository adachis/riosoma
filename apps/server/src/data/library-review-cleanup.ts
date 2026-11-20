import { ident, query, sql, type Queryable } from '@riosoma/db';

/** Reserved people who never join lose their pending private payloads with their last invitation. */
export async function eraseExpiredLibraryReviews(db: Queryable, schema: string, orgId?: string) {
  const review = ident(schema, 'organization_import_review');
  await query(
    db,
    sql`WITH abandoned AS (
    SELECT p.org_id, p.target_id FROM ${review} p
    WHERE p.kind = 'knowledgeLibrary' AND p.done_at IS NULL
      AND (${orgId ?? null}::text IS NULL OR p.org_id = ${orgId ?? null})
      AND p.detail->'row'->>'scope' = 'personal'
      AND NOT EXISTS (SELECT 1 FROM ${ident(schema, 'memberships')} m
        WHERE m.org_id = p.org_id AND m.user_id = p.detail->'row'->>'target')
      AND EXISTS (SELECT 1 FROM ${ident(schema, 'invitations')} i
        WHERE i.org_id = p.org_id AND i.reserved_user_id = p.detail->'row'->>'target'
          AND i.accepted_at IS NULL AND i.expires_at <= clock_timestamp())
      AND NOT EXISTS (SELECT 1 FROM ${ident(schema, 'invitations')} i
        WHERE i.org_id = p.org_id AND i.reserved_user_id = p.detail->'row'->>'target'
          AND i.accepted_at IS NULL AND i.expires_at > clock_timestamp())
  ) UPDATE ${review} p SET detail = '{}'::jsonb, done_at = now()
    FROM abandoned a WHERE p.org_id = a.org_id AND p.done_at IS NULL
      AND ((p.kind = 'knowledgeLibrary' AND p.target_id = a.target_id)
        OR (p.kind = 'knowledgeDocument' AND p.detail->'row'->>'library_id' = a.target_id))`,
  );
}
