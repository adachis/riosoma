import { Trans, useLingui } from '@lingui/react/macro';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Button, Heading, Spinner, Text } from '@riosoma/ui';
import { RiosomaLogo } from '../../brand/RiosomaLogo';
import { ErrorBanner } from '../../shell/ErrorBanner';
import { errorInfo } from '../../screens/setup/useSetup';
import { confirmUnsubscribe, previewUnsubscribe } from './api';
import '../../screens/setup/SetupScreen.css';
import './reports.css';

function readToken(): string | null {
  const token = new URLSearchParams(window.location.search).get('token');
  return token && token.length <= 2000 ? token : null;
}

/**
 * Where the link at the foot of a report email lands.  It works without signing in: the link
 * names the report and the person, and one press stops that person receiving it.  Opening the page
 * changes nothing, so a mail scanner that follows links can't stop anyone's report.
 */
export function UnsubscribeScreen() {
  const { t } = useLingui();
  const [token] = useState(readToken);
  const preview = useQuery({
    queryKey: ['reports', 'unsubscribe', token],
    queryFn: ({ signal }) => previewUnsubscribe(token!, signal),
    enabled: token !== null,
    retry: false,
  });
  const stop = useMutation({ mutationFn: () => confirmUnsubscribe(token!) });
  const report = preview.data?.reportName ?? '';
  const view = preview.data?.viewName ?? '';
  const failed = token === null ? { key: 'reports.unsubscribe.invalid' } : errorInfo(preview.error);

  return (
    <div className="rio-page-center">
      <div className="rio-card rio-setup rio-report-unsubscribe">
        <div className="rio-setup__brand">
          <RiosomaLogo />
        </div>
        {failed ? (
          <>
            <Heading level={1}>
              <Trans id="reports.unsubscribe.failedTitle">That link didn’t work</Trans>
            </Heading>
            <ErrorBanner error={failed} />
          </>
        ) : !preview.data ? (
          <Spinner label={t({ id: 'reports.unsubscribe.loading', message: 'Checking the link' })} />
        ) : stop.isSuccess || !preview.data.receiving ? (
          <div role="status">
            <Heading level={1}>
              <Trans id="reports.unsubscribe.doneTitle">You won’t get {report} anymore</Trans>
            </Heading>
            <Text>
              <Trans id="reports.unsubscribe.done">
                Whoever set it up can add you again if you ask them to.
              </Trans>
            </Text>
          </div>
        ) : (
          <>
            <Heading level={1}>
              <Trans id="reports.unsubscribe.title">Stop receiving {report}?</Trans>
            </Heading>
            <Text>
              {t({
                id: 'reports.unsubscribe.body',
                message: `It’s a scheduled report of the ${view} view.  Nobody else stops getting it.`,
              })}
            </Text>
            <ErrorBanner error={errorInfo(stop.error)} />
            <div>
              <Button variant="primary" isPending={stop.isPending} onPress={() => stop.mutate()}>
                <Trans id="reports.unsubscribe.confirm">Stop receiving it</Trans>
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
