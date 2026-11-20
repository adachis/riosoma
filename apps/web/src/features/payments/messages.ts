import { msg } from '@lingui/core/macro';

export const PAYMENT_MESSAGES = {
  'payments.activeBookings': msg({
    id: 'payments.activeBookings',
    message:
      'This page has upcoming bookings that are paid or waiting for payment.  Turn it off to stop new bookings.',
  }),
  'payments.belowMinimum': msg({
    id: 'payments.belowMinimum',
    message: 'Prices in {currency} have to be at least {minimum}, the smallest amount Stripe charges.',
  }),
  'payments.checkoutFailed': msg({
    id: 'payments.checkoutFailed',
    message:
      'Stripe couldn’t start the payment, so you haven’t been charged.  Please try again in a few minutes.',
  }),
  'payments.checkoutFailed.booking': msg({
    id: 'payments.checkoutFailed.booking',
    message:
      'Stripe couldn’t start the payment, so you haven’t been charged and the time isn’t held for you.  Please try again in a few minutes.',
  }),
  'payments.holdWaiting': msg({
    id: 'payments.holdWaiting',
    message:
      'You already have a booking on this page waiting for payment.  Finish paying for it, or try again once it expires, within 30 minutes.',
  }),
  'payments.holdsFull': msg({
    id: 'payments.holdsFull',
    message: 'Too many bookings on this day are waiting for payment.  Please try again in a few minutes.',
  }),
  'payments.invalid': msg({
    id: 'payments.invalid',
    message: 'The payment details do not match.  Check the price, currency, option, and quantity.',
  }),
  'payments.unavailable': msg({
    id: 'payments.unavailable',
    message: 'Payment is unavailable right now.  Please contact the page owner before submitting again.',
  }),
  'payments.badKey': msg({
    id: 'payments.badKey',
    message: 'Stripe could not verify this key.  Check the key and its permission to read the balance.',
  }),
  'payments.notConnected': msg({
    id: 'payments.notConnected',
    message: 'Connect Stripe in Integrations before accepting payments.',
  }),
  'payments.baseUrl': msg({
    id: 'payments.baseUrl',
    message: 'Set the server’s public address before connecting Stripe.',
  }),
  'payments.protected': msg({
    id: 'payments.protected',
    message: 'Only Riosoma can change payment result fields.',
  }),
  'payments.answersLocked': msg({
    id: 'payments.answersLocked',
    message: 'Answers that set the price can’t be changed after payment starts.',
  }),
};
export const paymentStates = {
  pending: msg({ id: 'payments.state.pending', message: 'Pending' }),
  paid: msg({ id: 'payments.state.paid', message: 'Paid' }),
  expired: msg({ id: 'payments.state.expired', message: 'Expired' }),
  refunded: msg({ id: 'payments.state.refunded', message: 'Refunded' }),
  failed: msg({ id: 'payments.state.failed', message: 'Failed' }),
};
export const paymentFields = {
  status: msg({ id: 'payments.field.status', message: 'Payment status' }),
  amount: msg({ id: 'payments.field.amount', message: 'Amount paid' }),
  reference: msg({ id: 'payments.field.reference', message: 'Payment reference' }),
};
