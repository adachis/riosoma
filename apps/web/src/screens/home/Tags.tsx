import { createContext, useContext, type CSSProperties } from 'react';
import { useLingui } from '@lingui/react/macro';
import type { HomeListing, HomeTag, TagResource } from '@riosoma/contracts';
import './items.css';

export const HomeTagsContext = createContext<HomeListing | undefined>(undefined);
export function TagPill({ tag }: { tag: HomeTag }) {
  const { t } = useLingui();
  return (
    <span
      className="rio-home-tag"
      data-private={tag.visibility === 'private'}
      style={{ '--rio-tag-color': tag.color } as CSSProperties}
    >
      <span aria-hidden="true" className="rio-home-tag__dot" />
      {tag.name}
      {tag.visibility === 'private' ? (
        <span className="rio-home-tag__private">{t({ id: 'home.tags.private', message: 'Private' })}</span>
      ) : null}
    </span>
  );
}
export function TagPills({ resource }: { resource: TagResource }) {
  const listing = useContext(HomeTagsContext);
  const ids = new Set(
    listing?.tagLinks
      ?.filter((link) => link.resource.kind === resource.kind && link.resource.id === resource.id)
      .map((link) => link.tagId),
  );
  return (
    <span className="rio-home-tags">
      {listing?.tags
        ?.filter((tag) => ids.has(tag.id))
        .map((tag) => (
          <TagPill key={tag.id} tag={tag} />
        ))}
    </span>
  );
}
