import { msg } from '@lingui/core/macro';

export const NOTIFICATION_MESSAGES = {
  'notifications.connection.teamsFailed': msg({
    id: 'notifications.connection.teamsFailed',
    message: 'Teams didn’t finish connecting.  Try again.',
  }),
  'notifications.connection.teamsUnavailable': msg({
    id: 'notifications.connection.teamsUnavailable',
    message: 'Teams sign-in isn’t set up for your organization, or an admin turned it off.',
  }),
  'notifications.connection.teamsAppRefused': msg({
    id: 'notifications.connection.teamsAppRefused',
    message:
      'Microsoft refused Riosoma’s app, so Teams can’t connect right now.  An admin needs to check the app’s tenant ID, client ID, and secret in Settings, Integrations.',
  }),
  'notifications.credentials.unavailable': msg({
    id: 'notifications.credentials.unavailable',
    message: 'The credential store could not be read.  An administrator needs to check the connection.',
  }),
  'notifications.push.invalid': msg({
    id: 'notifications.push.invalid',
    message: 'This push subscription is not valid.  Subscribe this device again.',
  }),
  'notifications.push.limit': msg({
    id: 'notifications.push.limit',
    message: 'You can subscribe up to 20 devices.  Unsubscribe a device first.',
  }),
  'notifications.push.unavailable': msg({
    id: 'notifications.push.unavailable',
    message:
      'This device could not subscribe.  Check notification permission in your browser, then try again.',
  }),
  'notifications.delivery.failed': msg({
    id: 'notifications.delivery.failed',
    message: 'The notification could not be delivered.',
  }),
  'notifications.channel.disabled': msg({
    id: 'notifications.channel.disabled',
    message: 'An administrator turned this channel off for the organization.',
  }),
  'notifications.channel.unavailable': msg({
    id: 'notifications.channel.unavailable',
    message: 'An administrator needs to connect this channel first.',
  }),
  'notifications.sms.adminOnly': msg({
    id: 'notifications.sms.adminOnly',
    message: 'SMS is available only to organization administrators for admin alerts.',
  }),
  'notifications.phone.rateLimited': msg({
    id: 'notifications.phone.rateLimited',
    message:
      'Wait before requesting another code.  Up to three codes can be sent per hour, at least a minute apart.',
  }),
  'notifications.phone.invalidCode': msg({
    id: 'notifications.phone.invalidCode',
    message: 'That code is incorrect or expired.  Check the code, or request a new one.',
  }),
  'notifications.phone.undoUnavailable': msg({
    id: 'notifications.phone.undoUnavailable',
    message: 'Phone verification cannot be undone.  Remove the phone number or verify it again.',
  }),
  'notifications.digest.invalidZone': msg({
    id: 'notifications.digest.invalidZone',
    message: 'Enter a valid time zone.',
  }),
};
