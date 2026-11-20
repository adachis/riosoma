import { faCircleCheck, faCircleMinus, faCircleXmark } from '@fortawesome/free-solid-svg-icons';
import { Trans, useLingui } from '@lingui/react/macro';
import type { SourceTestResult } from '@riosoma/contracts';
import { Icon, type IconDefinition } from '@riosoma/icons';
import { Banner, Disclosure, DisclosurePanel, DisclosureTrigger, Text } from '@riosoma/ui';
import { useServerMessage } from '../../../messages/useServerMessage';
import { STEP_NAMES, STEP_STATUS_LABELS, type StepStatus } from './labels';
import './sources.css';

const STATUS_ICONS: Record<StepStatus, IconDefinition> = {
  ok: faCircleCheck,
  failed: faCircleXmark,
  skipped: faCircleMinus,
};

/**
 * One row per step of the climb, in the order the server climbed it.  A failure carries the
 * server's own advice, a step that passed may carry a note, like a source with nothing in it yet,
 * and the driver's words stay behind a disclosure: they help someone who knows the system and mean
 * little to everyone else.
 */
export function TestSteps({ result }: { result: SourceTestResult }) {
  const { t, i18n } = useLingui();
  const message = useServerMessage();
  const version = result.serverVersion;
  return (
    <section className="rio-sources__test" aria-label={t({ id: 'sources.test', message: 'Test connection' })}>
      {result.ok ? (
        <Banner tone="success">
          {version
            ? t({ id: 'sources.test.passed', message: `Connected to ${version}.` })
            : t({ id: 'sources.test.passedNoVersion', message: 'Connected.' })}
        </Banner>
      ) : null}
      <ol className="rio-sources__steps">
        {result.steps.map((step, index) => (
          <li key={`${step.step}:${index}`} className="rio-sources__step" data-status={step.status}>
            <span className="rio-sources__step-row">
              <Icon icon={STATUS_ICONS[step.status]} className="rio-sources__step-icon" />
              <Text className="rio-sources__step-name">{i18n._(STEP_NAMES[step.step])}</Text>
              <Text variant="muted" className="rio-sources__step-status">
                {i18n._(STEP_STATUS_LABELS[step.status])}
              </Text>
              <Text variant="muted" className="rio-sources__step-time">
                {/* A localized unit keeps the number free of hard-coded words. */}
                {step.ms === null
                  ? ''
                  : i18n.number(step.ms, {
                      style: 'unit',
                      unit: 'millisecond',
                      unitDisplay: 'narrow',
                      useGrouping: false,
                    })}
              </Text>
            </span>
            {/* Skipped objects can explain which permission the key is missing. */}
            {step.messageKey ? (
              <Text className="rio-sources__step-message">{message(step.messageKey, step.params)}</Text>
            ) : null}
            {typeof step.params?.keyUrl === 'string' && /^https:\/\//.test(step.params.keyUrl) ? (
              <a href={step.params.keyUrl} target="_blank" rel="noopener noreferrer">
                <Trans id="sources.app.createKey">Create a key</Trans>
              </a>
            ) : null}
            {step.messageKey === 'sources.test.driverMissing' ? (
              <a href="/settings/source-drivers">
                <Trans id="sources.drivers.title">Drivers</Trans>
              </a>
            ) : null}
            {step.detail ? (
              <Disclosure className="rio-sources__step-details">
                <DisclosureTrigger level={4}>
                  <Trans id="sources.test.details">Details</Trans>
                </DisclosureTrigger>
                <DisclosurePanel>
                  <Text variant="mono">{step.detail}</Text>
                </DisclosurePanel>
              </Disclosure>
            ) : null}
          </li>
        ))}
      </ol>
    </section>
  );
}
