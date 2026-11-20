import { t } from '@lingui/core/macro';
import { I18nProvider } from 'react-aria-components';
import { DateField } from './DateField';
import type { GalleryEntry } from './gallery';

export const gallery: GalleryEntry = {
  id: 'ui.dateField',
  title: 'DateField',
  examples: [
    {
      id: 'sizes',
      render: () => (
        <>
          <DateField
            size="sm"
            label={t({ id: 'ui.date.gallery.small', message: 'Small' })}
            defaultValue="2026-09-27"
          />
          <DateField
            label={t({ id: 'ui.date.gallery.medium', message: 'Medium' })}
            defaultValue="2026-09-27"
          />
          <DateField
            size="lg"
            label={t({ id: 'ui.date.gallery.large', message: 'Large' })}
            defaultValue="2026-09-27"
          />
        </>
      ),
    },
    {
      id: 'states',
      render: () => (
        <>
          <DateField label={t({ id: 'ui.date.gallery.empty', message: 'Empty' })} />
          <DateField label={t({ id: 'ui.date.gallery.required', message: 'Required' })} isRequired />
          <DateField
            label={t({ id: 'ui.date.gallery.readOnly', message: 'Read only' })}
            defaultValue="2026-09-27"
            isReadOnly
          />
          <DateField
            label={t({ id: 'ui.date.gallery.disabled', message: 'Disabled' })}
            defaultValue="2026-09-27"
            isDisabled
          />
          <DateField
            label={t({ id: 'ui.date.gallery.departure', message: 'Departure' })}
            defaultValue="2026-09-27"
            description={t({ id: 'ui.date.gallery.help', message: 'Choose the departure day' })}
          />
          <DateField
            label={t({ id: 'ui.date.gallery.invalid', message: 'Invalid' })}
            defaultValue="2026-09-27"
            isInvalid
            errorMessage={t({ id: 'ui.date.gallery.error', message: 'Choose a later date' })}
          />
        </>
      ),
    },
    {
      id: 'time',
      render: () => (
        <>
          <DateField
            label={t({ id: 'ui.date.gallery.twelveHour', message: 'Los Angeles, 12-hour clock' })}
            includeTime
            hourCycle={12}
            timeZone="America/Los_Angeles"
            defaultValue="2026-09-27T22:05:00.000Z"
          />
          <DateField
            label={t({ id: 'ui.date.gallery.twentyFourHour', message: 'Los Angeles, 24-hour clock' })}
            includeTime
            hourCycle={24}
            timeZone="America/Los_Angeles"
            defaultValue="2026-09-27T22:05:00.000Z"
          />
        </>
      ),
    },
    {
      id: 'locales',
      render: () => (
        <>
          <I18nProvider locale="en-US">
            <DateField
              label={t({ id: 'ui.date.gallery.english', message: 'American English' })}
              defaultValue="2026-09-27"
            />
          </I18nProvider>
          <I18nProvider locale="de">
            <DateField
              label={t({ id: 'ui.date.gallery.german', message: 'German' })}
              defaultValue="2026-09-27"
            />
          </I18nProvider>
          <I18nProvider locale="ar">
            <DateField
              label={t({ id: 'ui.date.gallery.arabic', message: 'Arabic' })}
              defaultValue="2026-09-27"
            />
          </I18nProvider>
        </>
      ),
    },
    {
      id: 'bounds',
      render: () => (
        <DateField
          label={t({ id: 'ui.date.gallery.bounded', message: 'Available dates' })}
          defaultValue="2026-09-27"
          minValue="2026-09-26"
          maxValue="2026-09-30"
          isDateUnavailable={(value) => value === '2026-09-28'}
        />
      ),
    },
  ],
};
