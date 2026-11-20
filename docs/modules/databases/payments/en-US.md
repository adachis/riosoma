---
id: payments
title: Taking payments on forms and booking pages
summary: Collect a fixed price, an option price, or a deposit through Stripe Checkout.
area: databases
order: 33
level: standard
related: [forms, booking-pages, automations, field-and-record-permissions]
---

Forms and booking pages can require payment through Stripe Checkout.  Visitors enter their card details on Stripe.  Riosoma never receives card details.

## Connecting your account

An organization owner or an administrator with the Integrations role opens {{ui:settings.nav.integrations}} and {{ui:payments.title}}.  Enter {{ui:payments.secretKey}} and {{ui:payments.webhookSecret}}, then choose {{ui:payments.connect}}.  Riosoma verifies the key with a read-only balance request before saving either secret.  Neither secret is returned to the browser.

A restricted key needs permission to read the balance, write Checkout Sessions, read PaymentIntents, and write refunds.  Test and live keys are accepted.  The connection says {{ui:payments.mode.test}} or {{ui:payments.mode.live}}.

Create a webhook destination for your account in Stripe, copy its signing secret, connect, and then replace that destination's temporary address with {{ui:payments.webhook.address}}.  Select these events:

- `checkout.session.completed`
- `checkout.session.async_payment_succeeded`
- `checkout.session.expired`
- `checkout.session.async_payment_failed`
- `charge.refunded`

Riosoma answers only correctly signed events from the last five minutes and applies each event once.  Refused webhooks for your connection reach the audit log as one entry an hour, with how many were refused and why.

Keep old webhook destinations when replacing or disconnecting a connection.  Existing payments still need their confirmations and refunds.  {{ui:payments.disconnect}} stops new Checkout Sessions.  The encrypted credentials for existing payments remain available to process their webhooks and refunds.

## Choosing a price

In the form designer, open {{ui:payments.settings}}.  For a booking page, save the page first, edit it, and open the same section.  Turn on {{ui:payments.required}}, choose {{ui:payments.currency}}, and choose a {{ui:payments.fixed}} or a single select question under {{ui:payments.priceSource}}.  Give every option a price.  An optional {{ui:payments.quantity}} multiplies that price by a whole number from 1 through 10,000.  Include both price and quantity fields among the page's questions.

Enter prices in ordinary currency units, such as 10.50 USD or 500 JPY.  Japanese yen and South Korean won accept whole units only.  Every price has to reach the currency's minimum, which the section shows once you choose a currency, and a lower price is refused when you save.  Each minimum is Stripe's published minimum charge for the currency, raised where needed so the charge converts to at least 50 US cents with some room for exchange rates to move.  Charges cannot exceed 999,999.99 in two-decimal currencies, or 99,999,999 in zero-decimal currencies.  Stripe can still refuse a total when a visitor pays, for example when your account settles in another currency with a higher minimum.  Taxes, discounts, and automatic currency conversion are not added by Riosoma.

Choose {{ui:payments.save}}.  Riosoma adds {{ui:payments.field.status}}, {{ui:payments.field.amount}}, and {{ui:payments.field.reference}}, and marks them as managed.  People can read these fields, subject to the table's access rules.  Only Riosoma can change their values or definitions.  That holds everywhere: in the grid, the API, imports, automations, merges, undo, and organization imports, and for owners too.  A form's visitors can't answer them, in any currency.  Turning payment off keeps earlier results.

## What happens after submitting

Riosoma calculates the amount from the saved settings and submitted answers, creates the record with {{ui:payments.state.pending}}, and sends the visitor to Checkout.  A form's responses belong to no one, the same as on a form without payment, and only the payment result values are written by Riosoma itself.  Returning from Checkout only displays {{ui:payments.confirming}}.  It never proves payment.  On a form that lets visitors edit their responses, the option and quantity answers that set the amount stay as they were charged, and a change to one is refused with "{{ui:payments.answersLocked}}"

Verified webhooks change the record to {{ui:payments.state.paid}}, {{ui:payments.state.expired}}, {{ui:payments.state.failed}}, or {{ui:payments.state.refunded}}.  Successful payment fills in the amount and reference.  Automations can watch these record changes.

If Stripe refuses to start Checkout, for example because it won't charge that total, the record changes to {{ui:payments.state.failed}} at once and the visitor hears that they weren't charged and can try again.

## Booking pages that charge

A pending booking holds its place while its Checkout Session is open, for 30 minutes, and until Stripe says the session expired or was paid.  A payment made just before the session closes can be confirmed a little later, so the place waits for it.  The expiry webhook usually arrives within moments of the session closing and frees the time.  If it never comes, the time is free again an hour after the session closed.  A failed or refunded payment frees it at once.

Putting a pending booking's record in the trash, or its table or database, gives up its place.  So does the booker canceling with the link in their email.  Riosoma frees the time at once and ends the Checkout Session at Stripe, so nobody can pay for a place that's free again, and the record changes to {{ui:payments.state.expired}}.  If a payment still arrives for a booking whose place was given up, Riosoma never confirms it.  It refunds the payment in full through Stripe, changes the record to {{ui:payments.state.refunded}}, emails the booker that the time couldn't be kept and that they've been refunded, and records the refund in the audit log.  The same happens when a booking's hold ended an hour after its session closed, its payment is confirmed after that, and someone else has booked its time in the meantime.  If Stripe can't take the refund right then, Stripe sends the webhook again later, and the refund happens then.

A paid booking counts by its record's time, like any other booking.  Moving it to another time in the table frees the old time and takes the new one, which then counts toward that time's places.  A paid booking sends its confirmation and calendar invitation once, when the payment is confirmed.

So that nobody can hold a page's places without paying:

- One internet connection can have one booking waiting for payment on a page at a time.  Trying again while it waits says to finish paying or wait for it to expire.  An IPv6 connection counts as its whole /64 network, which one household or device usually holds, and the hourly limit on booking attempts counts the same way.
- Bookings waiting for payment can take at most a third of a day's places, and at least one.  Past that, visitors are asked to try again in a few minutes.

A page with an upcoming booking that's paid, or still waiting for its payment, cannot be deleted.  Turn it off to stop new bookings while keeping existing reservations.

## Moving an organization

An organization export carries each form's and booking page's payment settings and their result fields, which stay managed.  It leaves out the Stripe connection, the payments, and their webhook history, and the result values in records, which belong to the Stripe account that took them.  After an import, a form or page that charges refuses answers until an Integrations administrator connects Stripe again.  It never takes them free.

## Refunding a payment

Open the record's {{ui:record.tab.history}} tab, open {{ui:payments.record.details}}, and choose {{ui:payments.refund}}.  This requires edit access to the table and record, plus the Integrations role.  Confirm {{ui:payments.refund.confirm}} to ask Stripe for a full refund.  The status changes only after Stripe's refund webhook arrives.  Partial refunds made in Stripe do not mark the whole payment Refunded.

## Technical references

Setup follows Stripe's [Checkout Session API](https://docs.stripe.com/api/checkout/sessions/create), [webhook signature verification](https://docs.stripe.com/webhooks/signature), [idempotency rules](https://docs.stripe.com/api/idempotent_requests), [currency rules](https://docs.stripe.com/currencies), and [refund API](https://docs.stripe.com/api/refunds/create).
