import { msg } from '@lingui/core/macro';
import { Setting, defineSettingsPage } from '../Setting';

import { useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { useMutation, useQuery } from '@tanstack/react-query';
import { AuditFilters, type AuditEntry, type AuditIntegrity, type AuditPage } from '@riosoma/contracts';
import { Button, Form, Heading, Spinner, TextField } from '@riosoma/ui';
import { api, apiFile } from '../../../api';
import { useSession } from '../../../session';
import { ErrorBanner } from '../../../shell/ErrorBanner';
import { errorInfo } from '../../setup/useSetup';
import { saveFile } from '../../database/view/download';
import { setAdminSearch, useAdminSearch } from '../admin-search';
import { organizationRole } from '../units/access';
import '../administration.css';

const settingsPage = defineSettingsPage({
  area: 'admin',
  section: 'organization',
  page: 'audit',
  label: msg({ id: 'settings.nav.audit', message: 'Audit' }),
  roles: ['audit'],
  keywords: msg({ id: 'settings.search.keywords.audit', message: 'audit events history logs' }),
});

const FILTER_KEYS = ['q', 'person', 'action', 'resource', 'from', 'to'] as const;
const validId = (value: string | null) => (value && /^[1-9][0-9]{0,18}$/.test(value) ? value : undefined);
const utcInput = (value: string | undefined) => (value ? new Date(value).toISOString().slice(0, 16) : '');

export function AuditSettings() {
  const session = useSession();
  return (
    <Setting page={settingsPage} id="overview" label={msg({ id: 'settings.nav.audit', message: 'Audit' })}>
      {organizationRole(session, 'audit') ? (
        <AuditLog />
      ) : (
        <ErrorBanner error={{ key: 'errors.adminOnly' }} />
      )}
    </Setting>
  );
}

function FilterForm({ filters }: { filters: AuditFilters }) {
  const { t } = useLingui();
  const [draft, setDraft] = useState(filters);
  const [errors, setErrors] = useState<Partial<Record<(typeof FILTER_KEYS)[number], string>>>({});
  const labels = {
    q: t({ id: 'audit.search', message: 'Search events' }),
    person: t({ id: 'audit.person', message: 'Person' }),
    action: t({ id: 'audit.action', message: 'Action' }),
    resource: t({ id: 'audit.resource', message: 'Resource' }),
    from: t({ id: 'audit.from', message: 'From, UTC' }),
    to: t({ id: 'audit.to', message: 'To, UTC' }),
  };
  return (
    <Setting
      page={settingsPage}
      id="audit-filters"
      label={msg({ id: 'settings.search.auditFilters', message: 'Audit filters' })}
    >
      <Form
        className="rio-audit-filters"
        onSubmit={(event) => {
          event.preventDefault();
          const parsed = AuditFilters.safeParse(draft);
          if (!parsed.success) {
            const form = event.currentTarget;
            const invalid: typeof errors = {};
            for (const issue of parsed.error.issues) {
              const key = issue.path[0] as (typeof FILTER_KEYS)[number] | undefined;
              if (key && FILTER_KEYS.includes(key))
                invalid[key] = t({ id: 'audit.filter.tooLong', message: 'Use 200 characters or fewer.' });
              else
                invalid.to = t({
                  id: 'audit.filter.timeOrder',
                  message: 'Choose an end time at or after the start time.',
                });
            }
            setErrors(invalid);
            requestAnimationFrame(() =>
              form.querySelector<HTMLInputElement>('[aria-invalid="true"]')?.focus(),
            );
            return;
          }
          setErrors({});
          setAdminSearch({
            ...Object.fromEntries(FILTER_KEYS.map((key) => [key, parsed.data[key]])),
            event: undefined,
            before: undefined,
          });
        }}
      >
        {FILTER_KEYS.map((key) => (
          <TextField
            key={key}
            label={labels[key]}
            type={key === 'from' || key === 'to' ? 'datetime-local' : 'text'}
            value={key === 'from' || key === 'to' ? utcInput(draft[key]) : (draft[key] ?? '')}
            isInvalid={Boolean(errors[key])}
            errorMessage={errors[key]}
            validationBehavior="aria"
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.preventDefault();
            }}
            onChange={(value) => {
              setErrors({});
              setDraft({
                ...draft,
                [key]:
                  value && (key === 'from' || key === 'to')
                    ? new Date(`${value}Z`).toISOString()
                    : value || undefined,
              });
            }}
          />
        ))}
        <Button type="submit" variant="primary">
          <Trans id="audit.filter">Filter events</Trans>
        </Button>
        <Button
          onPress={() => {
            setDraft({});
            setErrors({});
            setAdminSearch(
              Object.fromEntries([...FILTER_KEYS, 'event', 'before'].map((key) => [key, undefined])),
            );
          }}
        >
          <Trans id="audit.clear">Clear filters</Trans>
        </Button>
      </Form>
    </Setting>
  );
}

function AuditLog() {
  const { i18n, t } = useLingui();
  const search = useAdminSearch();
  const supplied = Object.fromEntries(
    FILTER_KEYS.flatMap((key) => (search.get(key) ? [[key, search.get(key)]] : [])),
  );
  const parsed = AuditFilters.safeParse(supplied);
  const filters = parsed.success ? parsed.data : {};
  const before = validId(search.get('before'));
  const eventId = validId(search.get('event'));
  const params = new URLSearchParams(Object.entries(filters));
  if (before) params.set('before', before);
  const events = useQuery({
    queryKey: ['org', 'audit', params.toString()],
    enabled: parsed.success,
    queryFn: ({ signal }) => api<AuditPage>(`/api/org/audit?${params}`, { signal }),
  });
  const detail = useQuery({
    queryKey: ['org', 'audit', 'event', eventId],
    enabled: Boolean(eventId),
    queryFn: ({ signal }) => api<AuditEntry>(`/api/org/audit/${eventId}`, { signal }),
  });
  const integrity = useMutation({ mutationFn: () => api<AuditIntegrity>('/api/org/audit/integrity') });
  const download = useMutation({
    mutationFn: async (format: 'csv' | 'json') => {
      const file = await apiFile('/api/org/audit/export', { body: { filters, format } });
      saveFile(file.blob, file.filename ?? `audit.${format}`);
    },
  });
  const link = (values: Record<string, string | undefined>) => {
    const next = new URLSearchParams(search);
    for (const [key, value] of Object.entries(values)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    return `/settings/audit?${next}`;
  };
  const firstBreak = integrity.data?.firstBreak;
  const checked = integrity.data?.checked ?? 0;
  return (
    <div className="rio-admin-panel">
      <FilterForm key={JSON.stringify(filters)} filters={filters} />
      {!parsed.success ? <ErrorBanner error={{ key: 'errors.validationFailed' }} /> : null}
      <div className="rio-audit-actions">
        <Button
          onPress={() => download.mutate('csv')}
          isPending={download.isPending}
          isDisabled={!parsed.success}
        >
          <Trans id="audit.exportCsv">Export CSV</Trans>
        </Button>
        <Button
          onPress={() => download.mutate('json')}
          isPending={download.isPending}
          isDisabled={!parsed.success}
        >
          <Trans id="audit.exportJson">Export JSON</Trans>
        </Button>
        <Button onPress={() => integrity.mutate()} isPending={integrity.isPending}>
          <Trans id="audit.integrity">Check integrity</Trans>
        </Button>
      </div>
      <ErrorBanner error={errorInfo(events.error ?? detail.error ?? download.error ?? integrity.error)} />
      {integrity.data ? (
        <div role="status">
          {firstBreak ? (
            <>
              <Trans id="audit.broken">The first break is at event {firstBreak}.</Trans>{' '}
              <a href={link({ event: firstBreak })}>
                <Trans id="audit.detail">Event details</Trans>
              </a>
            </>
          ) : (
            t({ id: 'audit.intact', message: `Checked ${checked} events.  No breaks found.` })
          )}
        </div>
      ) : null}
      {eventId && detail.isPending ? <Spinner /> : null}
      {eventId && detail.data ? (
        <section className="rio-audit-detail" aria-labelledby="audit-event-title">
          <Heading level={2} id="audit-event-title">
            <Trans id="audit.detail">Event details</Trans>
          </Heading>
          <a href={link({ event: undefined })}>
            <Trans id="audit.closeDetail">Close details</Trans>
          </a>
          <dl className="rio-admin-diff">
            <div>
              <dt>
                <Trans id="audit.eventId">Event ID</Trans>
              </dt>
              <dd>{detail.data.id}</dd>
            </div>
            <div>
              <dt>
                <Trans id="audit.person">Person</Trans>
              </dt>
              <dd>
                {detail.data.actorName ?? detail.data.actorId ?? <Trans id="audit.system">System</Trans>}
              </dd>
            </div>
            <div>
              <dt>
                <Trans id="audit.action">Action</Trans>
              </dt>
              <dd>{detail.data.action}</dd>
            </div>
            <div>
              <dt>
                <Trans id="audit.resource">Resource</Trans>
              </dt>
              <dd>{detail.data.resource}</dd>
            </div>
            <div>
              <dt>
                <Trans id="audit.time">Time</Trans>
              </dt>
              <dd>
                <time dateTime={detail.data.at}>
                  {i18n.date(new Date(detail.data.at), { dateStyle: 'medium', timeStyle: 'medium' })}
                </time>
              </dd>
            </div>
            <div>
              <dt>
                <Trans id="audit.metadata">Recorded details</Trans>
              </dt>
              <dd>
                <pre>{JSON.stringify(detail.data.metadata, null, 2)}</pre>
              </dd>
            </div>
            <div>
              <dt>
                <Trans id="audit.hash">Hash</Trans>
              </dt>
              <dd>{detail.data.hash}</dd>
            </div>
            <div>
              <dt>
                <Trans id="audit.previousHash">Previous hash</Trans>
              </dt>
              <dd>{detail.data.prevHash}</dd>
            </div>
          </dl>
        </section>
      ) : null}
      {events.isFetching ? <Spinner /> : null}
      <ul className="rio-audit-events">
        {events.data?.events.map((event) => (
          <li key={event.id}>
            <a href={link({ event: event.id })}>{event.action}</a>
            <span>{event.actorName ?? event.actorId ?? <Trans id="audit.system">System</Trans>}</span>
            <time dateTime={event.at}>
              {i18n.date(new Date(event.at), { dateStyle: 'medium', timeStyle: 'short' })}
            </time>
            {event.resource ? <span>{event.resource}</span> : null}
          </li>
        ))}
      </ul>
      {events.data?.events.length === 0 ? (
        <p role="status">
          <Trans id="audit.empty">No events match these filters.</Trans>
        </p>
      ) : null}
      {events.data?.next ? (
        <a href={link({ before: events.data.next, event: undefined })}>
          <Trans id="audit.older">Older events</Trans>
        </a>
      ) : null}
      {before ? (
        <a href={link({ before: undefined, event: undefined })}>
          <Trans id="audit.newest">Newest events</Trans>
        </a>
      ) : null}
    </div>
  );
}
