import { useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import { useMutation, useQuery } from '@tanstack/react-query';
import type { RecordPayment as Payment } from '@riosoma/contracts';
import { Button, Dialog, DialogBody, DialogFooter, DialogTitle, Modal } from '@riosoma/ui';
import { api } from '../../api';
import { useSession } from '../../session';
import { canManageIntegrations } from '../../screens/settings/connections/IntegrationsSettings';
import { ErrorBanner } from '../../shell/ErrorBanner';
import { errorInfo } from '../../screens/setup/useSetup';
import { paymentStates } from './messages';

type RecordProps = { tableId: string; recordId: string };

export function RecordPayment(props: RecordProps) {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onPress={() => setOpen(!open)} aria-expanded={open}>
        {t({ id: 'payments.record.details', message: 'Payment details' })}
      </Button>
      {open && <PaymentDetails {...props} />}
    </>
  );
}

function PaymentDetails({ tableId, recordId }: RecordProps) {
  const { t, i18n } = useLingui();
  const session = useSession();
  const [confirming, setConfirming] = useState(false);
  const path = `/api/tables/${tableId}/records/${recordId}/payment`;
  const payment = useQuery({
    queryKey: ['record-payment', tableId, recordId],
    queryFn: () => api<Payment | null>(path),
    enabled: canManageIntegrations(session),
    refetchInterval: 15_000,
  });
  const refund = useMutation({
    mutationFn: () => api(path, { method: 'POST', body: {} }),
    onSuccess: () => {
      setConfirming(false);
      void payment.refetch();
    },
  });
  if (!canManageIntegrations(session)) return <ErrorBanner error={{ key: 'errors.adminOnly' }} />;
  if (!payment.data)
    return (
      <>
        <ErrorBanner error={errorInfo(payment.error)} />
        {payment.isSuccess && (
          <p>{t({ id: 'payments.record.none', message: 'No payment for this record.' })}</p>
        )}
      </>
    );
  return (
    <section className="rio-payments">
      <p>{i18n._(paymentStates[payment.data.state])}</p>
      {refund.isSuccess && (
        <p role="status">
          {t({
            id: 'payments.refund.requested',
            message: 'Refund requested.  The payment status will change when Stripe confirms it.',
          })}
        </p>
      )}
      {payment.data.refundable && (
        <Button onPress={() => setConfirming(true)}>
          {t({ id: 'payments.refund', message: 'Refund payment' })}
        </Button>
      )}
      <Modal isOpen={confirming} onOpenChange={setConfirming}>
        <Dialog>
          <DialogTitle>
            {t({ id: 'payments.refund.title', message: 'Refund this payment in full?' })}
          </DialogTitle>
          <DialogBody>
            <p>
              {t({
                id: 'payments.refund.help',
                message: 'Stripe will return the full payment to the original payment method.',
              })}
            </p>
            <ErrorBanner error={errorInfo(refund.error)} />
          </DialogBody>
          <DialogFooter>
            <Button onPress={() => setConfirming(false)}>
              {t({ id: 'payments.refund.cancel', message: 'Keep payment' })}
            </Button>
            <Button isPending={refund.isPending} onPress={() => refund.mutate()}>
              {t({ id: 'payments.refund.confirm', message: 'Refund in full' })}
            </Button>
          </DialogFooter>
        </Dialog>
      </Modal>
    </section>
  );
}
