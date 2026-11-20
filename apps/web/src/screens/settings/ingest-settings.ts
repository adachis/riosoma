import { msg } from '@lingui/core/macro';
import { defineSettingsPage, defineSettingItems } from './Setting';

// Registration precedes the controls, so these entries have no visible roles yet.
const page = defineSettingsPage({
  area: 'admin',
  section: 'integrations',
  page: 'files',
  label: msg({ id: 'files.settings.title', message: 'File uploads' }),
  roles: [],
});
export const ingestSettings = defineSettingItems(page, {
  ingestOriginalKeepDays: {
    label: msg({ id: 'ingest.settings.originalKeepDays', message: 'Keep original incoming files' }),
    help: msg({
      id: 'ingest.settings.originalKeepDays.help',
      message:
        'Keep originals for 30, 90, 180, or 365 days, a custom number of days, or forever.  Starts at 90 days.  Example files never expire.',
    }),
  },
  ingestProbationFiles: {
    label: msg({ id: 'ingest.settings.probationFiles', message: 'Files on probation for a new format' }),
    help: msg({
      id: 'ingest.settings.probationFiles.help',
      message: 'Choose from 1 to 10 files before a new reading format leaves probation.  Starts at 3 files.',
    }),
  },
});
