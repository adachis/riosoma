import { useLingui } from '@lingui/react/macro';
import './payments.css';

export function PaymentConfirmScreen() {
  const { t } = useLingui();
  return (
    <main className="rio-payments">
      <p role="status">
        {t({ id: 'payments.confirming', message: 'Thanks, we’re confirming your payment.' })}
      </p>
    </main>
  );
}
