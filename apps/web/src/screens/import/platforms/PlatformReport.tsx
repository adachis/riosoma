import type { I18n } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { useLingui } from '@lingui/react/macro';
import {
  PLATFORM_NAMES,
  type AirtableReportItem,
  type ImportPlatform,
  type PlatformImport,
} from '@riosoma/contracts';
import { Button, Dialog, DialogBody, DialogFooter, DialogTitle, Modal } from '@riosoma/ui';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { serverMessage } from '../../../messages/useServerMessage';
import { AirtableReportView } from '../airtable/AirtableReport';
import { clearPendingReport, reportPending } from '../airtable/pending';
import { databaseImports } from './api';
import { PLATFORM_REPORT_MESSAGES, PLATFORM_UNKNOWN_LINE } from './reportMessages';

/** One line of an import's report from another tool, in the reader's language. */
export function platformLine(platform: ImportPlatform) {
  return (i18n: I18n, item: AirtableReportItem): string => {
    const descriptor = PLATFORM_REPORT_MESSAGES[item.messageKey] ?? PLATFORM_UNKNOWN_LINE;
    const line = i18n._({ ...descriptor, values: { product: PLATFORM_NAMES[platform], ...item.params } });
    return item.detail ? `${line}  ${serverMessage(i18n, item.detail.messageKey, item.detail.params)}` : line;
  };
}

const REPORT_TITLE = msg({ id: 'import.platform.reportTitle', message: '{product} import report' });

/** The report's title, which also names it in the database's settings menu. */
export function reportTitle(i18n: I18n, platform: ImportPlatform): string {
  return i18n._({ ...REPORT_TITLE, values: { product: PLATFORM_NAMES[platform] } });
}

export function PlatformReportDialog({ job, onClose }: { job: PlatformImport; onClose(): void }) {
  const { t, i18n } = useLingui();
  const title = reportTitle(i18n, job.platform);
  return (
    <Modal
      isOpen
      isDismissable
      size="lg"
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog hideCloseButton>
        <DialogTitle>{title}</DialogTitle>
        <DialogBody>
          {job.report ? (
            <AirtableReportView
              report={job.report}
              line={platformLine(job.platform)}
              exactKey="import.platform.report.exact"
            />
          ) : null}
        </DialogBody>
        <DialogFooter>
          <Button variant="primary" onPress={onClose}>
            {t({ id: 'import.airtable.close', message: 'Close' })}
          </Button>
        </DialogFooter>
      </Dialog>
    </Modal>
  );
}

/**
 * The report kept with a database that came from another tool: whether there is one, which tool it
 * came from, a way to open it, and the dialog when it's open.  It opens by itself right after the
 * import that made it.
 */
export function usePlatformReport(databaseId: string, enabled: boolean) {
  const [openFor, setOpenFor] = useState<string | null>(() =>
    reportPending(databaseId) ? databaseId : null,
  );
  useEffect(() => {
    clearPendingReport(databaseId);
  }, [databaseId]);
  const imports = useQuery({
    queryKey: ['platform-imports', databaseId],
    queryFn: () => databaseImports(databaseId),
    enabled: enabled || openFor === databaseId,
    retry: false,
    staleTime: 60_000,
  });
  const latest = imports.data?.find((item) => item.report !== null) ?? null;
  return {
    platform: latest?.platform ?? null,
    open: () => setOpenFor(databaseId),
    dialog:
      openFor === databaseId && latest ? (
        <PlatformReportDialog job={latest} onClose={() => setOpenFor(null)} />
      ) : null,
  };
}
