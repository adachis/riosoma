import type { I18n } from '@lingui/core';
import { useLingui } from '@lingui/react/macro';
import {
  ROLLUP_FUNCTIONS,
  type AirtableImport,
  type AirtableReport,
  type AirtableReportItem,
  type RollupFunction,
} from '@riosoma/contracts';
import {
  Button,
  Dialog,
  DialogBody,
  DialogFooter,
  DialogTitle,
  Disclosure,
  DisclosurePanel,
  DisclosureTrigger,
  Modal,
} from '@riosoma/ui';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import { serverMessage } from '../../../messages/useServerMessage';
import { databaseImports } from './api';
import { clearPendingReport, reportPending } from './pending';
import { REPORT_MESSAGES, ROLLUP_NAMES, SUMMARY, UNKNOWN_LINE } from './reportMessages';
import './AirtableImport.css';

/** One line of a report in the reader's language, with any further reason after it. */
export function reportLine(i18n: I18n, item: AirtableReportItem): string {
  const descriptor = REPORT_MESSAGES[item.messageKey] ?? UNKNOWN_LINE;
  const values: Record<string, string | number> = { ...item.params };
  const fn = values.fn;
  if (typeof fn === 'string' && (ROLLUP_FUNCTIONS as readonly string[]).includes(fn))
    values.fn = i18n._(ROLLUP_NAMES[fn as RollupFunction]);
  const line = i18n._({ ...descriptor, values });
  return item.detail ? `${line}  ${serverMessage(i18n, item.detail.messageKey, item.detail.params)}` : line;
}

/** How a report's lines read, which each kind of import supplies. */
export type ReportLine = (i18n: I18n, item: AirtableReportItem) => string;

function Lines({ items, line }: { items: readonly AirtableReportItem[]; line: ReportLine }) {
  const { i18n, t } = useLingui();
  const place = (item: AirtableReportItem) => {
    const table = item.table;
    const name = item.name;
    if (table === null) return null;
    return name === null ? table : t({ id: 'import.airtable.report.place', message: `${table} › ${name}` });
  };
  return (
    <ul className="rio-airtable-report__lines">
      {items.map((item, index) => {
        const where = place(item);
        const formula = item.params.formula;
        return (
          <li key={index}>
            {where ? <strong className="rio-airtable-report__place">{where}</strong> : null}
            <span>{line(i18n, item)}</span>
            {typeof formula === 'string' && formula ? (
              <code className="rio-airtable-report__formula">{formula}</code>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * What an import brought across: what was left out and what changed, each with why, and what came
 * across exactly, table by table.  Airtable's lines read by default, and other tools' imports pass
 * their own, with the message key their lines use for what came across as it was.
 */
export function AirtableReportView({
  report,
  line = reportLine,
  exactKey = 'import.airtable.report.exact',
}: {
  report: AirtableReport;
  line?: ReportLine;
  exactKey?: string;
}) {
  const { i18n, t } = useLingui();
  const list = new Intl.ListFormat(i18n.locale, { type: 'conjunction' });
  const omitted = report.items.filter((item) => item.status === 'omitted');
  const changed = report.items.filter((item) => item.status === 'changed');
  const exact = report.items.filter((item) => item.status === 'exact');
  const tables = [...new Set(exact.flatMap((item) => (item.table === null ? [] : [item.table])))];
  const names = (table: string, subject: AirtableReportItem['subject']) =>
    exact
      .filter((item) => item.table === table && item.subject === subject && item.name !== null)
      .map((item) => item.name!);
  const { tables: tableCount, records, views, files } = report;
  const section = (title: ReactNode, body: ReactNode, open: boolean) => (
    <Disclosure defaultExpanded={open}>
      <DisclosureTrigger>{title}</DisclosureTrigger>
      <DisclosurePanel>{body}</DisclosurePanel>
    </Disclosure>
  );
  const omittedCount = omitted.length;
  const changedCount = changed.length;
  const exactCount = exact.length;
  return (
    <div className="rio-airtable-report">
      <p className="rio-airtable-report__summary">
        {i18n._({ ...SUMMARY, values: { tables: tableCount, records, views, files } })}
      </p>
      {omitted.length
        ? section(
            t({ id: 'import.airtable.report.omittedTitle', message: `Left out (${omittedCount})` }),
            <Lines items={omitted} line={line} />,
            true,
          )
        : null}
      {changed.length
        ? section(
            t({ id: 'import.airtable.report.changedTitle', message: `Changed (${changedCount})` }),
            <Lines items={changed} line={line} />,
            true,
          )
        : null}
      {section(
        t({ id: 'import.airtable.report.exactTitle', message: `Came across exactly (${exactCount})` }),
        <div className="rio-airtable-report__tables">
          {tables.map((table) => {
            const fields = names(table, 'field');
            const views = names(table, 'view');
            const fieldList = list.format(fields);
            const viewList = list.format(views);
            const lines = exact.filter(
              (item) => item.table === table && item.messageKey !== exactKey && item.subject !== 'field',
            );
            return (
              <section key={table} className="rio-airtable-report__table" aria-label={table}>
                <h4>{table}</h4>
                {lines.map((item, index) => (
                  <p key={index}>{line(i18n, item)}</p>
                ))}
                {fields.length ? (
                  <p>{t({ id: 'import.airtable.report.exactFields', message: `Fields: ${fieldList}` })}</p>
                ) : null}
                {views.length ? (
                  <p>{t({ id: 'import.airtable.report.exactViews', message: `Views: ${viewList}` })}</p>
                ) : null}
              </section>
            );
          })}
        </div>,
        false,
      )}
    </div>
  );
}

export function AirtableReportDialog({ job, onClose }: { job: AirtableImport; onClose(): void }) {
  const { t } = useLingui();
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
        <DialogTitle>
          {t({ id: 'import.airtable.reportTitle', message: 'Airtable import report' })}
        </DialogTitle>
        <DialogBody>{job.report ? <AirtableReportView report={job.report} /> : null}</DialogBody>
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
 * The report kept with a database that came from Airtable: whether there is one, a way to open
 * it, and the dialog when it's open.  It opens by itself right after the import that made it.
 */
export function useAirtableReport(databaseId: string, enabled: boolean) {
  const [openFor, setOpenFor] = useState<string | null>(() =>
    reportPending(databaseId) ? databaseId : null,
  );
  useEffect(() => {
    clearPendingReport(databaseId);
  }, [databaseId]);
  const imports = useQuery({
    queryKey: ['airtable-imports', databaseId],
    queryFn: () => databaseImports(databaseId),
    enabled: enabled || openFor === databaseId,
    retry: false,
    staleTime: 60_000,
  });
  const latest = imports.data?.find((item) => item.report !== null) ?? null;
  return {
    available: latest !== null,
    open: () => setOpenFor(databaseId),
    dialog:
      openFor === databaseId && latest ? (
        <AirtableReportDialog job={latest} onClose={() => setOpenFor(null)} />
      ) : null,
  };
}
