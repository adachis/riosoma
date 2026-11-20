import { Trans, useLingui } from '@lingui/react/macro';
import type { UpdateRelease } from '@riosoma/contracts';
import { Heading, Text } from '@riosoma/ui';
import { RichTextView } from '../../fields/richText/lazy';

/**
 * One release: its version, date, whether it fixes a security problem, and its notes.  The notes
 * are plain text or the limited Markdown rich text fields use, drawn by the same read-only view, so
 * nothing in them can become markup and only web and mail addresses become links.
 */
export function ReleaseNotes({ release, level = 3 }: { release: UpdateRelease; level?: 2 | 3 | 4 }) {
  const { t } = useLingui();
  const { version, date } = release;
  const title = t({ id: 'updates.release.title', message: `Riosoma ${version}` });
  return (
    <section className="rio-updates__release" aria-label={title}>
      <Heading level={level}>{title}</Heading>
      <Text variant="small" className="rio-updates__date">
        <Trans id="updates.release.date">Released {date}</Trans>
        {release.security ? (
          <span className="rio-updates__security">
            <Trans id="updates.release.security">Security release</Trans>
          </span>
        ) : null}
      </Text>
      {release.notes.trim() ? <RichTextView value={release.notes} className="rio-updates__notes" /> : null}
    </section>
  );
}
