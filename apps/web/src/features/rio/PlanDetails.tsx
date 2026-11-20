import './plan-preview.css';
import { Trans, useLingui } from '@lingui/react/macro';
import type { RioPlanPreview } from '@riosoma/contracts';

/** These settings come from validated commands and are always visible before approval. */
export function PlanDetails({ details }: Pick<RioPlanPreview, 'details'>) {
  const { t } = useLingui();
  if (!details?.length) return null;
  return (
    <section className="rio-plan-details">
      <h3>
        <Trans id="rio.plan.details">Changes to review</Trans>
      </h3>
      {details.map((detail, index) => (
        <pre
          key={index}
          role="region"
          tabIndex={0}
          aria-label={t({ id: 'rio.plan.details', message: 'Changes to review' })}
        >
          {detail.configuration}
        </pre>
      ))}
    </section>
  );
}
