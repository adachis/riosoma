import { plural } from '@lingui/core/macro';
import { useLingui } from '@lingui/react/macro';
import {
  automationConnectionProblems,
  type AutomationConfig,
  type AutomationMeta,
  type AutomationVersion,
  type AutomationVersionsList,
} from '@riosoma/contracts';
import { Banner, Button, Spinner, useConfirm } from '@riosoma/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api, ApiError } from '../../../api';
import type { DatabaseSession, SchemaState } from '../../../data/types';
import { reportError } from '../../../grid/view/actions';
import { useServerMessage } from '../../../messages/useServerMessage';
import { useRelativeTime } from '../../../relative-time';
import { TRIGGER_LABELS } from './labels';
import { VersionDiff } from './VersionDiff';
import { ConnectionProblems } from './Connections';

export function versionsKey(automationId: string) {
  return ['automations', automationId, 'versions'] as const;
}

/**
 * The badge an automation wears while it has changes that aren't live, with the buttons that
 * publish them or throw them away.  Nothing shows when there's no draft.
 */
export function DraftBar({
  session,
  automation,
  config,
  save,
  discard: clearDraft,
}: {
  session: DatabaseSession;
  automation: AutomationMeta;
  config?: AutomationConfig;
  save(): Promise<unknown>;
  discard(): Promise<unknown>;
}) {
  const { t } = useLingui();
  const confirm = useConfirm();
  const editing = config ?? automation.draft?.config ?? automation.config;
  const [showProblems, setShowProblems] = useState(false);
  if (!automation.draft) return null;
  const version = automation.version ?? 1;
  const send = (kind: 'automation.publish' | 'automation.discardDraft') => {
    try {
      session.run([{ kind, automationId: automation.id }]);
    } catch (error) {
      reportError(error);
    }
  };
  const publish = async () => {
    if (automationConnectionProblems(editing).length) {
      setShowProblems(true);
      return;
    }
    // Changes still waiting to save go out first, so what's published is what's on screen.
    try {
      await save();
      send('automation.publish');
    } catch (error) {
      reportError(error);
    }
  };
  const discard = async () => {
    const sure = await confirm({
      title: t({ id: 'automations.draft.discardTitle', message: 'Discard the draft?' }),
      message: t({
        id: 'automations.draft.discardMessage',
        message: `Version ${version} stays as it is.  You can undo this.`,
      }),
      confirmLabel: t({ id: 'automations.draft.discard', message: 'Discard' }),
      tone: 'danger',
    });
    if (sure) {
      try {
        await clearDraft();
        send('automation.discardDraft');
      } catch (error) {
        reportError(error);
      }
    }
  };
  return (
    <section
      className="rio-automation-draft"
      aria-label={t({ id: 'automations.draft.label', message: 'Draft' })}
    >
      <span className="rio-automation-draft__badge">
        {t({ id: 'automations.draft.badge', message: 'Draft: not live yet' })}
      </span>
      <p className="rio-automation-draft__note">
        {automation.publishedAt === null
          ? t({
              id: 'automations.draft.first',
              message: 'Publish this draft before turning the automation on.',
            })
          : t({
              id: 'automations.draft.note',
              message: `Changes save to this draft.  Version ${version} keeps running until you publish.`,
            })}
      </p>
      <VersionDiff
        before={automation.publishedAt === null ? null : automation.config}
        after={automation.draft.config}
      />
      <div className="rio-automation-draft__actions">
        <Button variant="primary" onPress={() => void publish()}>
          {t({ id: 'automations.draft.publish', message: 'Publish' })}
        </Button>
        {automation.publishedAt !== null ? (
          <Button onPress={() => void discard()}>
            {t({ id: 'automations.draft.discard', message: 'Discard' })}
          </Button>
        ) : null}
      </div>
      {showProblems ? (
        <div role="alert">
          <ConnectionProblems config={editing} />
        </div>
      ) : null}
    </section>
  );
}

/** The published version and the ones kept before it, newest first, each able to come back as a draft. */
export function Versions({
  session,
  schema,
  automation,
  canEdit,
  onRestored,
}: {
  session: DatabaseSession;
  schema: SchemaState;
  automation: AutomationMeta;
  canEdit: boolean;
  onRestored(): void;
}) {
  const { t } = useLingui();
  const message = useServerMessage();
  const confirm = useConfirm();
  const versions = useQuery({
    // A publish changes the list, so the published number is part of the key.
    queryKey: [...versionsKey(automation.id), automation.version ?? 1],
    queryFn: ({ signal }) =>
      api<AutomationVersionsList>(`/api/automations/${automation.id}/versions`, { signal }),
  });
  if (versions.isPending) return <Spinner label={t({ id: 'automations.versions', message: 'Versions' })} />;
  if (versions.isError)
    return (
      <Banner tone="danger">
        {message(versions.error instanceof ApiError ? versions.error.info.messageKey : 'errors.internal')}
      </Banner>
    );
  const restore = async (version: number) => {
    // Restoring over a draft replaces it, so that's asked first.
    if (
      automation.draft &&
      !(await confirm({
        title: t({ id: 'automations.versions.replaceTitle', message: 'Replace the draft?' }),
        message: t({
          id: 'automations.versions.replaceMessage',
          message: `Version ${version} becomes the draft in place of the changes there now.  You can undo this.`,
        }),
        confirmLabel: t({ id: 'automations.versions.restore', message: 'Restore as draft' }),
      }))
    )
      return;
    try {
      session.run([{ kind: 'automation.restoreVersion', automationId: automation.id, version }]);
      onRestored();
    } catch (error) {
      reportError(error);
    }
  };
  return (
    <div className="rio-automation-versions">
      <p className="rio-automation-versions__note">
        {t({
          id: 'automations.versions.note',
          message:
            'Publishing keeps the version it replaces, the last 20 of them.  Restoring one makes it the draft, to look over and publish.',
        })}
      </p>
      <ol className="rio-automation-versions__list">
        {versions.data.versions.map((version) => (
          <VersionRow
            key={version.version}
            version={version}
            by={version.publishedBy ? schema.collaborators.get(version.publishedBy)?.name : undefined}
            canRestore={canEdit && !version.live}
            onRestore={() => void restore(version.version)}
          />
        ))}
      </ol>
    </div>
  );
}

function VersionRow({
  version,
  by,
  canRestore,
  onRestore,
}: {
  version: AutomationVersion;
  by: string | undefined;
  canRestore: boolean;
  onRestore(): void;
}) {
  const { t, i18n } = useLingui();
  const when = useRelativeTime(version.publishedAt ?? '');
  const number = version.version;
  const count = version.steps;
  const name = by ?? '';
  return (
    <li className="rio-automation-versions__item" data-live={version.live || undefined}>
      <span className="rio-automation-versions__name">
        {t({ id: 'automations.versions.name', message: `Version ${number}` })}
      </span>
      {version.live ? (
        <span className="rio-automation-run__tag">
          {t({ id: 'automations.versions.live', message: 'Published' })}
        </span>
      ) : null}
      <span className="rio-automation-versions__detail">{i18n._(TRIGGER_LABELS[version.trigger])}</span>
      <span className="rio-automation-versions__detail">
        {t({ id: 'automations.versions.steps', message: plural(count, { one: '# step', other: '# steps' }) })}
      </span>
      {version.publishedAt ? (
        <time className="rio-automation-versions__detail" dateTime={version.publishedAt}>
          {by
            ? t({ id: 'automations.versions.publishedBy', message: `Published ${when} by ${name}` })
            : t({ id: 'automations.versions.published', message: `Published ${when}` })}
        </time>
      ) : null}
      {canRestore ? (
        <Button size="sm" className="rio-automation-versions__restore" onPress={onRestore}>
          {t({ id: 'automations.versions.restore', message: 'Restore as draft' })}
        </Button>
      ) : null}
    </li>
  );
}
