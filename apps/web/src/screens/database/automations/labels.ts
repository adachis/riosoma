import {
  faBell,
  faCircleCheck,
  faCircleXmark,
  faClipboardList,
  faClock,
  faEnvelope,
  faFilter,
  faForward,
  faGlobe,
  faHourglassHalf,
  faLink,
  faPen,
  faSpinner,
  faSquarePlus,
} from '@fortawesome/free-solid-svg-icons';
import { msg } from '@lingui/core/macro';
import type { MessageDescriptor } from '@lingui/core';
import type { IconDefinition } from '@riosoma/icons';
import type { AutomationRunState } from '@riosoma/contracts';
import type { Problem } from './problems';
import type { StepKind, TriggerKind } from './model';

export const TRIGGER_LABELS: Record<TriggerKind, MessageDescriptor> = {
  recordCreated: msg({ id: 'automations.trigger.recordCreated', message: 'A record is created' }),
  recordUpdated: msg({ id: 'automations.trigger.recordUpdated', message: 'A record is updated' }),
  recordMatches: msg({ id: 'automations.trigger.recordMatches', message: 'A record starts matching' }),
  formSubmitted: msg({ id: 'automations.trigger.formSubmitted', message: 'A form is submitted' }),
  schedule: msg({ id: 'automations.trigger.schedule', message: 'On a schedule' }),
  webhook: msg({ id: 'automations.trigger.webhook', message: 'Another app calls a webhook' }),
};

export const STEP_LABELS: Record<StepKind, MessageDescriptor> = {
  findRecords: msg({ id: 'automations.step.findRecords', message: 'Find records' }),
  createCalendarEvent: msg({
    id: 'automations.step.createCalendarEvent',
    message: 'Create a calendar event',
  }),
  generateDocument: msg({ id: 'automations.step.generateDocument', message: 'Generate a document' }),
  askAi: msg({ id: 'automations.step.askAi', message: 'Ask AI' }),
  if: msg({ id: 'automations.step.if', message: 'If' }),
  switch: msg({ id: 'automations.step.switch', message: 'Switch' }),
  repeat: msg({ id: 'automations.step.repeat', message: 'Repeat for each' }),
  wait: msg({ id: 'automations.step.wait', message: 'Wait' }),
  slack: msg({ id: 'automations.step.slack', message: 'Post to Slack' }),
  studioFlow: msg({ id: 'automations.step.studioFlow', message: 'Post through Copilot Studio' }),
  teams: msg({ id: 'automations.step.teams', message: 'Post to Teams' }),
  discord: msg({ id: 'automations.step.discord', message: 'Post to Discord' }),
  sms: msg({ id: 'automations.step.sms', message: 'Send a text message' }),
  script: msg({ id: 'automations.step.script', message: 'Run a script' }),
  updateRecord: msg({ id: 'automations.step.updateRecord', message: 'Update a record' }),
  createRecord: msg({ id: 'automations.step.createRecord', message: 'Create a record' }),
  sendNotification: msg({ id: 'automations.step.sendNotification', message: 'Send a notification' }),
  sendEmail: msg({ id: 'automations.step.sendEmail', message: 'Send an email' }),
  callWebhook: msg({ id: 'automations.step.callWebhook', message: 'Call a webhook' }),
};

export const RUN_STATE_LABELS: Record<AutomationRunState, MessageDescriptor> = {
  waiting: msg({ id: 'automations.run.waiting', message: 'Waiting at a step' }),
  canceled: msg({ id: 'automations.run.canceled', message: 'Canceled' }),
  queued: msg({ id: 'automations.run.queued', message: 'Waiting' }),
  running: msg({ id: 'automations.run.running', message: 'Running' }),
  succeeded: msg({ id: 'automations.run.succeeded', message: 'Done' }),
  failed: msg({ id: 'automations.run.failed', message: 'Failed' }),
  skipped: msg({ id: 'automations.run.skipped', message: 'Skipped' }),
};

export const PROBLEM_LABELS: Record<Problem, MessageDescriptor> = {
  missing: msg({ id: 'automations.problem.missing', message: 'Something this step uses was deleted.' }),
  order: msg({ id: 'automations.problem.order', message: 'This step uses a record from a later step.' }),
};

export const TRIGGER_ICONS: Record<TriggerKind, IconDefinition> = {
  recordCreated: faSquarePlus,
  recordUpdated: faPen,
  recordMatches: faFilter,
  formSubmitted: faClipboardList,
  schedule: faClock,
  webhook: faLink,
};

export const STEP_ICONS: Record<StepKind, IconDefinition> = {
  findRecords: faFilter,
  createCalendarEvent: faClock,
  generateDocument: faClipboardList,
  askAi: faClipboardList,
  if: faFilter,
  switch: faFilter,
  repeat: faForward,
  wait: faClock,
  slack: faGlobe,
  teams: faGlobe,
  studioFlow: faGlobe,
  discord: faGlobe,
  sms: faEnvelope,
  script: faClipboardList,
  updateRecord: faPen,
  createRecord: faSquarePlus,
  sendEmail: faEnvelope,
  sendNotification: faBell,
  callWebhook: faGlobe,
};

export const RUN_STATE_ICONS: Record<AutomationRunState, IconDefinition> = {
  waiting: faClock,
  canceled: faCircleXmark,
  queued: faHourglassHalf,
  running: faSpinner,
  succeeded: faCircleCheck,
  failed: faCircleXmark,
  skipped: faForward,
};
