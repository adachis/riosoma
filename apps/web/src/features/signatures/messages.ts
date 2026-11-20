import { msg } from '@lingui/core/macro';

export const signatureKinds = {
  signature: msg({ id: 'signatures.field.signature', message: 'Signature' }),
  initials: msg({ id: 'signatures.field.initials', message: 'Initials' }),
  date: msg({ id: 'signatures.field.date', message: 'Date signed' }),
  name: msg({ id: 'signatures.field.name', message: 'Name' }),
  text: msg({ id: 'signatures.field.text', message: 'Text box' }),
};
export const signatureStates = {
  open: msg({ id: 'signatures.state.open', message: 'Awaiting signatures' }),
  completing: msg({ id: 'signatures.state.completing', message: 'Finishing the signed PDF' }),
  completed: msg({ id: 'signatures.state.completed', message: 'Completed' }),
  failed: msg({ id: 'signatures.state.failed', message: 'Stopped: couldn’t finish' }),
  declined: msg({ id: 'signatures.state.declined', message: 'Declined' }),
  canceled: msg({ id: 'signatures.state.canceled', message: 'Canceled' }),
  expired: msg({ id: 'signatures.state.expired', message: 'Expired' }),
  pending: msg({ id: 'signatures.state.pending', message: 'Pending' }),
  signed: msg({ id: 'signatures.state.signed', message: 'Signed' }),
};
export const signatureEvents = {
  sent: msg({ id: 'signatures.event.sent', message: 'Sent' }),
  opened: msg({ id: 'signatures.event.opened', message: 'Opened' }),
  signed: signatureStates.signed,
  declined: signatureStates.declined,
  reminded: msg({ id: 'signatures.event.reminded', message: 'Reminded' }),
  completed: signatureStates.completed,
  canceled: signatureStates.canceled,
  failed: msg({ id: 'signatures.event.failed', message: 'Couldn’t finish the signed PDF' }),
  undelivered: msg({ id: 'signatures.event.undelivered', message: 'Email not delivered after 10 tries' }),
};
export const SIGNATURE_MESSAGES = {
  'signatures.unavailable': msg({
    id: 'signatures.unavailable',
    message: 'This signing request is unavailable.  It may have been signed, declined, canceled, or expired.',
  }),
  'signatures.changed': msg({
    id: 'signatures.changed',
    message: 'The source document has changed.  Cancel this request and send a new one.',
  }),
  'signatures.invalidPdf': msg({
    id: 'signatures.invalidPdf',
    message: 'Choose a readable PDF that has passed its file scan.',
  }),
  'signatures.pdfLimit': msg({
    id: 'signatures.pdfLimit',
    message: 'Choose a PDF with no more than 200 pages and 20 MB.',
  }),
  'signatures.invalidImage': msg({
    id: 'signatures.invalidImage',
    message: 'Choose a valid signature image with no more than two million pixels.',
  }),
  'signatures.invalid': msg({
    id: 'signatures.invalid',
    message:
      'Check the signers and fields.  Each signer needs a signature field, and each email address must be different.',
  }),
  'signatures.expired': msg({ id: 'signatures.expired', message: 'Choose a due date in the future.' }),
  'signatures.mailUnavailable': msg({
    id: 'signatures.mailUnavailable',
    message: 'Signature requests need email delivery and the server’s public address configured.',
  }),
  'signatures.consentRequired': msg({
    id: 'signatures.consentRequired',
    message: 'Review the electronic signing agreement and agree before signing.',
  }),
  'signatures.required': msg({
    id: 'signatures.required',
    message: 'Complete every field assigned to you before signing.',
  }),
  'signatures.reminderLimit': msg({
    id: 'signatures.reminderLimit',
    message: 'You can send each signer one reminder every 24 hours.',
  }),
  'signatures.textTooLong': msg({
    id: 'signatures.textTooLong',
    message: 'Keep each text answer to {limit} characters or fewer.',
  }),
  'signatures.stampFailed': msg({
    id: 'signatures.stampFailed',
    message:
      'Your signature couldn’t be added to the document, so this request has stopped.  The person who sent it has been told.',
  }),
  'signatures.requestLimit': msg({
    id: 'signatures.requestLimit',
    message: 'You’ve sent as many signature requests as you can in an hour.  Try again later.',
  }),
  'signatures.signerLimit': msg({
    id: 'signatures.signerLimit',
    message: 'You’ve added as many signers as you can in a day.  Try again tomorrow.',
  }),
  'signatures.invalidField': msg({
    id: 'signatures.invalidField',
    message: 'Choose a status field and a completion date field you can see and change, of the right type.',
  }),
  'signatures.overlap': msg({
    id: 'signatures.overlap',
    message: 'Fields can’t overlap.  Place this one where no other field is.',
  }),
  'signatures.xfa': msg({
    id: 'signatures.xfa',
    message:
      'This PDF uses an XFA form, which can’t be signed here.  Save it as a standard PDF and attach that.',
  }),
  'signatures.rateLimited': msg({
    id: 'signatures.rateLimited',
    message: 'Too many signing requests.  Wait a minute and try again.',
  }),
};
