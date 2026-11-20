import { useLingui } from '@lingui/react/macro';
import type { PaymentSettings } from '@riosoma/contracts';

export function PaymentNotice({ payment }: { payment?: PaymentSettings | null }) {
  const { t } = useLingui();
  if (!payment) return null;
  const currency = payment.currency.toUpperCase();
  return (
    <p>
      {t({
        id: 'payments.notice',
        message: `Payment in ${currency} is required.  You’ll review the total and pay securely through Stripe after submitting.`,
      })}
    </p>
  );
}
