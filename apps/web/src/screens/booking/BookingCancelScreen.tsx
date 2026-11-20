import { useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import { useMutation, useQuery } from '@tanstack/react-query';
import { DEFAULT_THEME } from '@riosoma/tokens';
import { Button, Spinner } from '@riosoma/ui';
import { confirmCancel, previewCancel } from '../../features/booking-pages/api';
import { localZone, stretch } from '../../features/booking-pages/words';
import { ErrorBanner } from '../../shell/ErrorBanner';
import { useTheme } from '../../shell/useAppliedTheme';
import { errorInfo } from '../setup/useSetup';
import { PublicLayout } from '../public-form/PublicFormScreen';
import '../public-form/public-form.css';
import './booking.css';

function readToken(): string | null {
  const token = new URLSearchParams(window.location.search).get('token');
  return token && token.length <= 200 ? token : null;
}

/**
 * Where the cancel link in a booking's confirmation email lands.  It works without signing in:
 * the link names the booking, and one press cancels it.  Opening the page changes nothing, so a
 * mail scanner that follows links can't cancel anyone's booking.
 */
export function BookingCancelScreen() {
  const { t, i18n } = useLingui();
  const locale = i18n.locale || 'en-US';
  const [token] = useState(readToken);
  useTheme(DEFAULT_THEME);
  const preview = useQuery({
    queryKey: ['public', 'bookings', 'cancel', token],
    queryFn: ({ signal }) => previewCancel(token!, signal),
    enabled: token !== null,
    retry: false,
  });
  const cancel = useMutation({ mutationFn: () => confirmCancel(token!) });
  const booking = cancel.data ?? preview.data;
  const failed = token === null ? { key: 'bookings.cancel.invalid' } : errorInfo(preview.error);
  const title = booking?.title ?? '';
  const when = booking ? stretch(booking.start, booking.end, locale, localZone()) : '';

  return (
    <PublicLayout>
      <div className="rio-public-form__page rio-booking-cancel">
        {failed ? (
          <>
            <h1>{t({ id: 'bookings.cancel.failedTitle', message: 'That link didn’t work' })}</h1>
            <ErrorBanner error={failed} />
          </>
        ) : !booking ? (
          <Spinner label={t({ id: 'bookings.cancel.loading', message: 'Checking the link' })} />
        ) : booking.state === 'canceled' ? (
          <div role="status" className="rio-booking-cancel">
            <h1>{t({ id: 'bookings.cancel.doneTitle', message: 'Your booking is canceled' })}</h1>
            <p>
              {t({
                id: 'bookings.cancel.done',
                message: `${title}, ${when}, is free for someone else now.`,
              })}
            </p>
          </div>
        ) : booking.state === 'started' ? (
          <>
            <h1>{title}</h1>
            <p>{when}</p>
            <ErrorBanner error={{ key: 'bookings.cancel.started' }} />
          </>
        ) : (
          <>
            <h1>{t({ id: 'bookings.cancel.title', message: `Cancel ${title}?` })}</h1>
            <p className="rio-booking__when">{when}</p>
            {booking.resource ? <p>{booking.resource}</p> : null}
            <p>
              {t({
                id: 'bookings.cancel.body',
                message: 'Canceling frees the time for someone else.  You can book again if it’s still open.',
              })}
            </p>
            <ErrorBanner error={errorInfo(cancel.error)} />
            <Button variant="danger" isPending={cancel.isPending} onPress={() => cancel.mutate()}>
              {t({ id: 'bookings.cancel.confirm', message: 'Cancel my booking' })}
            </Button>
          </>
        )}
      </div>
    </PublicLayout>
  );
}
