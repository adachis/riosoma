import { RiosomaLogo } from '../../brand/RiosomaLogo';
import { Trans, useLingui } from '@lingui/react/macro';
import { Link, useRouter } from '@tanstack/react-router';
import { faCircleQuestion } from '@fortawesome/free-solid-svg-icons';
import type { UpdateStatus } from '@riosoma/contracts';
import { Button, Heading, Text } from '@riosoma/ui';
import { UPDATES_HELP } from './api';
import { ReleaseNotes } from './ReleaseNotes';
import { UpdateSteps } from './UpdateSteps';
import './updates.css';

export function UpdateDetails({
  status,
  title,
  onClose,
}: {
  status: UpdateStatus;
  title: string;
  onClose(): void;
}) {
  const { t } = useLingui();
  const router = useRouter({ warn: false });
  return (
    <>
      <RiosomaLogo />
      <Heading level={2}>{title}</Heading>
      <Text variant="small">
        <Trans id="updates.notice.current">This server runs {status.version}.</Trans>
      </Text>
      {status.security ? (
        <Text className="rio-update-notice__warning">
          {t({
            id: 'updates.notice.securityNote',
            message: 'A newer release fixes a security problem.  Update soon.',
          })}
        </Text>
      ) : null}
      <div className="rio-update-notice__notes">
        {status.available.map((release) => (
          <ReleaseNotes key={release.version} release={release} level={3} />
        ))}
      </div>
      {status.target ? (
        <>
          <Heading level={3}>
            <Trans id="updates.how">How to update</Trans>
          </Heading>
          {status.canUpdate ? (
            <Text>
              {t({
                id: 'updates.notice.oneClick',
                message:
                  'Update in one click from the update settings.  The updater backs up the database first.',
              })}
            </Text>
          ) : (
            <UpdateSteps status={status} release={status.target} />
          )}
        </>
      ) : null}
      <div className="rio-update-notice__actions">
        <Link
          to="/settings/$section"
          params={{ section: 'updates' }}
          className="rio-update-notice__open"
          onClick={() => onClose()}
        >
          <Trans id="updates.notice.open">Open update settings</Trans>
        </Link>
        <Button
          variant="quiet"
          size="sm"
          icon={faCircleQuestion}
          onPress={() => {
            onClose();
            void router?.navigate({
              to: '.',
              search: (previous: Record<string, unknown>) => ({ ...previous, help: UPDATES_HELP }),
            });
          }}
        >
          {t({ id: 'updates.notice.help', message: 'About updates' })}
        </Button>
      </div>
    </>
  );
}
