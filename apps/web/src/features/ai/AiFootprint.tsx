import { useSettingsDraft } from '../../screens/settings/SettingsDraft';
import { useId, useState, type Key } from 'react';
import { msg, plural } from '@lingui/core/macro';
import { useLingui } from '@lingui/react/macro';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { faDownload } from '@fortawesome/free-solid-svg-icons';
import type { AiFootprintReport, AiUsageTotals } from '@riosoma/contracts';
import { ComboBox, Heading, Link, ListBoxItem, Select, Spinner } from '@riosoma/ui';
import { api, ApiError } from '../../api';
import { useServerMessage } from '../../messages/useServerMessage';
import { FootprintHelp } from '../ai-footprint/FootprintHelp';
import { useFootprintFormat } from '../ai-footprint/format';
import { zoneName } from '../ai-footprint/zones';
import './AiFootprint.css';
import { Setting, SettingItem, defineSettingsPage, defineSettingItems } from '../../screens/settings/Setting';

const settingsPage = defineSettingsPage({
  area: 'admin',
  section: 'connections',
  page: 'ai',
  label: msg({ id: 'settings.nav.ai', message: 'AI' }),
  roles: ['organization-ai'],
});
const settings = defineSettingItems(settingsPage, {
  'footprint-month': { label: msg({ id: 'ai.footprint.pickMonth', message: 'Show a month' }) },
});
const zoneHelp = msg({
  id: 'ai.footprint.zoneHelp',
  message:
    'Carbon estimates use this zone’s electricity mix.  Pick where the models you use run, when you know it.  Energy estimates don’t depend on it.',
});

const reportQuery = {
  queryKey: ['ai', 'footprint', 'report'],
  queryFn: () => api<AiFootprintReport>('/api/ai/footprint'),
};

/** The id of the zone choice that follows the server's setting */
const SERVER_ZONE = 'server';

/**
 * The AI settings' footprint section: the organization's AI use by month, feature, and model, with
 * its cost and estimated energy and carbon, a CSV of the same, and the electricity zone the
 * carbon figures use.
 */
export function AiFootprintSection() {
  const { t } = useLingui();
  const message = useServerMessage();
  const query = useQuery(reportQuery);
  const title = t({ id: 'ai.footprint.title', message: 'AI footprint' });
  return (
    <section className="rio-ai-footprint" aria-label={title}>
      <Heading level={2}>{title}</Heading>
      {query.isPending ? (
        <Spinner />
      ) : query.error ? (
        <p role="alert">
          {message(query.error instanceof ApiError ? query.error.info.messageKey : 'errors.internal')}
        </p>
      ) : (
        <Report report={query.data} />
      )}
    </section>
  );
}

function Report({ report }: { report: AiFootprintReport }) {
  const { t, i18n } = useLingui();
  const captions = useId();
  const format = useFootprintFormat();
  const newest = report.months[0]?.month ?? null;
  const [picked, setPicked] = useState<string | null>(null);
  const month = picked && report.months.some((row) => row.month === picked) ? picked : newest;
  const monthName = (value: string) =>
    i18n.date(new Date(`${value}T00:00:00Z`), { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const method = report.method;
  const cells = (row: AiUsageTotals) => {
    const calls = row.calls;
    return (
      <>
        <td>{i18n.number(calls)}</td>
        <td>
          {row.pricedCalls > 0
            ? format.cost(row.costUsd)
            : t({ id: 'ai.footprint.unknown', message: 'Unknown' })}
        </td>
        <td>
          {row.estimatedCalls > 0
            ? format.energy(row.energyWh)
            : t({ id: 'ai.footprint.noEstimate', message: 'No estimate' })}
        </td>
        <td>
          {row.estimatedCalls > 0
            ? format.carbon(row.gwpG)
            : t({ id: 'ai.footprint.noEstimate', message: 'No estimate' })}
        </td>
        <td>
          {row.estimatedCalls < calls
            ? t({
                id: 'ai.footprint.partly',
                message: plural(row.estimatedCalls, {
                  one: `# of ${calls} estimated`,
                  other: `# of ${calls} estimated`,
                }),
              })
            : null}
        </td>
      </>
    );
  };
  const head = (first: string) => (
    <thead>
      <tr>
        <th scope="col">{first}</th>
        <th scope="col">{t({ id: 'ai.footprint.uses', message: 'Uses' })}</th>
        <th scope="col">{t({ id: 'ai.footprint.cost', message: 'Cost' })}</th>
        <th scope="col">{t({ id: 'ai.footprint.energy', message: 'Energy (estimate)' })}</th>
        <th scope="col">{t({ id: 'ai.footprint.carbon', message: 'Carbon (estimate)' })}</th>
        <th scope="col">
          <span className="rio-ai-footprint__hidden">
            {t({ id: 'ai.footprint.coverage', message: 'Coverage' })}
          </span>
        </th>
      </tr>
    </thead>
  );
  return (
    <>
      <p>
        {t({
          id: 'ai.footprint.intro',
          message: `Your organization’s AI use, with its cost and estimated energy and carbon.  Model generation estimates use ${method}.  Search and embedding estimates use configured service power and request duration.`,
        })}
      </p>
      <FootprintHelp />
      <ZonePicker report={report} />
      {newest === null ? (
        <SettingItem definition={settings['footprint-month']}>
          <p>{t({ id: 'ai.footprint.empty', message: 'No AI use yet.' })}</p>
        </SettingItem>
      ) : (
        <>
          <div
            className="rio-ai-footprint__scroll"
            role="region"
            tabIndex={0}
            aria-labelledby={`${captions}-month`}
          >
            <table className="rio-ai-footprint__table">
              <caption id={`${captions}-month`}>
                {t({ id: 'ai.footprint.byMonth', message: 'By month' })}
              </caption>
              {head(t({ id: 'ai.footprint.month', message: 'Month' }))}
              <tbody>
                {report.months.map((row) => (
                  <tr key={row.month}>
                    <th scope="row">{monthName(row.month)}</th>
                    {cells(row)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <SettingItem definition={settings['footprint-month']}>
            <Select
              label={t({ id: 'ai.footprint.pickMonth', message: 'Show a month' })}
              selectedKey={month}
              onSelectionChange={(key) => setPicked(typeof key === 'string' ? key : null)}
            >
              {report.months.map((row) => (
                <ListBoxItem id={row.month} key={row.month}>
                  {monthName(row.month)}
                </ListBoxItem>
              ))}
            </Select>
          </SettingItem>
          <div
            className="rio-ai-footprint__scroll"
            role="region"
            tabIndex={0}
            aria-labelledby={`${captions}-feature`}
          >
            <table className="rio-ai-footprint__table">
              <caption id={`${captions}-feature`}>
                {t({ id: 'ai.footprint.byFeature', message: 'By feature' })}
              </caption>
              {head(t({ id: 'ai.footprint.feature', message: 'Feature' }))}
              <tbody>
                {report.byFeature
                  .filter((row) => row.month === month)
                  .map((row) => (
                    <tr key={row.feature}>
                      <th scope="row">{format.feature(row.feature)}</th>
                      {cells(row)}
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
          <div
            className="rio-ai-footprint__scroll"
            role="region"
            tabIndex={0}
            aria-labelledby={`${captions}-model`}
          >
            <table className="rio-ai-footprint__table">
              <caption id={`${captions}-model`}>
                {t({ id: 'ai.footprint.byModel', message: 'By model' })}
              </caption>
              {head(t({ id: 'ai.footprint.model', message: 'Model' }))}
              <tbody>
                {report.byModel
                  .filter((row) => row.month === month)
                  .map((row) => (
                    <tr key={`${row.providerId}/${row.model}`}>
                      <th scope="row">{row.model}</th>
                      {cells(row)}
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
          <Link href="/api/ai/footprint.csv" download="ai-footprint.csv" icon={faDownload}>
            {t({ id: 'ai.footprint.download', message: 'Download as CSV' })}
          </Link>
        </>
      )}
    </>
  );
}

function ZonePicker({ report }: { report: AiFootprintReport }) {
  const { t, i18n } = useLingui();
  const client = useQueryClient();
  const draft = useSettingsDraft(report.zone.organization, async (electricityZone) => {
    await api('/api/ai/settings', { method: 'PUT', body: { electricityZone } });
    await Promise.all([
      client.invalidateQueries({ queryKey: ['ai', 'footprint'] }),
      client.invalidateQueries({ queryKey: ['ai', 'settings'] }),
    ]);
  });
  const busy = draft.saving;
  const server = zoneName(i18n, report.zone.server);
  const serverLabel = t({ id: 'ai.footprint.zoneServer', message: `The server’s setting: ${server}` });
  const choose = (key: Key | null) => {
    if (key !== null) draft.setValue(key === SERVER_ZONE ? null : String(key));
  };
  return (
    <div className="rio-ai-footprint__zone">
      <Setting
        page={settingsPage}
        id="electricity-zone"
        label={msg({ id: 'ai.footprint.zone', message: 'Electricity zone' })}
        help={zoneHelp}
      >
        <ComboBox
          label={t({ id: 'ai.footprint.zone', message: 'Electricity zone' })}
          description={t(zoneHelp)}
          selectedKey={draft.value ?? SERVER_ZONE}
          isDisabled={busy}
          onSelectionChange={(key) => void choose(key)}
        >
          <ListBoxItem id={SERVER_ZONE} textValue={serverLabel}>
            {serverLabel}
          </ListBoxItem>
          {report.zones.map((zone) => {
            const name = zoneName(i18n, zone);
            return (
              <ListBoxItem id={zone} key={zone} textValue={name}>
                {name}
              </ListBoxItem>
            );
          })}
        </ComboBox>
      </Setting>
      {busy ? <Spinner /> : null}
    </div>
  );
}
