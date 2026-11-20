import { useLingui } from '@lingui/react/macro';
import {
  faCircleCheck,
  faCircleMinus,
  faCircleXmark,
  faTriangleExclamation,
} from '@fortawesome/free-solid-svg-icons';
import type { DiagnosticReport } from '@riosoma/contracts';
import { Icon } from '@riosoma/icons';
import { useServerMessage } from '../../messages/useServerMessage';

const ICONS = {
  ok: faCircleCheck,
  warn: faTriangleExclamation,
  fail: faCircleXmark,
  skipped: faCircleMinus,
} as const;

/** The connection check, one line per rung, with the suggested fix under a failure. */
export function DiagnosticList({ report }: { report: DiagnosticReport }) {
  const { t } = useLingui();
  const message = useServerMessage();
  const statusLabel = {
    ok: t({ id: 'setup.diagnose.status.ok', message: 'Passed' }),
    warn: t({ id: 'setup.diagnose.status.warn', message: 'Warning' }),
    fail: t({ id: 'setup.diagnose.status.fail', message: 'Failed' }),
    skipped: t({ id: 'setup.diagnose.status.skipped', message: 'Skipped' }),
  };
  return (
    <ol
      className="rio-diagnostics"
      aria-label={t({ id: 'setup.diagnose.title', message: 'Connection check' })}
    >
      {report.steps.map((step) => (
        <li key={step.step} className="rio-diagnostics__step" data-status={step.status}>
          <Icon
            icon={ICONS[step.status]}
            label={statusLabel[step.status]}
            className="rio-diagnostics__icon"
          />
          <div>
            <div>{message(step.messageKey, step.params)}</div>
            {step.fixKey ? <div className="rio-diagnostics__fix">{message(step.fixKey)}</div> : null}
          </div>
        </li>
      ))}
    </ol>
  );
}
