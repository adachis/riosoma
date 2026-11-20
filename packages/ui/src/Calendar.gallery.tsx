import { t } from '@lingui/core/macro';
import { I18nProvider } from 'react-aria-components';
import { Calendar } from './Calendar';
import type { GalleryEntry } from './gallery';

export const gallery: GalleryEntry = {
  id: 'ui.calendar',
  title: 'Calendar',
  examples: [
    {
      id: 'states',
      render: () => (
        <>
          <Calendar aria-label={t({ id: 'ui.date.gallery.empty', message: 'Empty' })} />
          <Calendar
            aria-label={t({ id: 'ui.date.gallery.departure', message: 'Departure' })}
            defaultValue="2026-09-27"
          />
          <Calendar
            aria-label={t({ id: 'ui.date.gallery.readOnly', message: 'Read only' })}
            defaultValue="2026-09-27"
            isReadOnly
          />
          <Calendar
            aria-label={t({ id: 'ui.date.gallery.disabled', message: 'Disabled' })}
            defaultValue="2026-09-27"
            isDisabled
          />
          <Calendar
            aria-label={t({ id: 'ui.date.gallery.invalid', message: 'Invalid' })}
            defaultValue="2026-09-27"
            isInvalid
          />
        </>
      ),
    },
    {
      id: 'bounds',
      render: () => (
        <Calendar
          aria-label={t({ id: 'ui.date.gallery.bounded', message: 'Available dates' })}
          defaultValue="2026-09-27"
          minValue="2026-09-26"
          maxValue="2026-09-30"
          isDateUnavailable={(value) => value === '2026-09-28'}
        />
      ),
    },
    {
      id: 'locales',
      render: () => (
        <>
          <I18nProvider locale="en-US">
            <Calendar
              aria-label={t({ id: 'ui.date.gallery.english', message: 'American English' })}
              defaultValue="2026-09-27"
            />
          </I18nProvider>
          <I18nProvider locale="de">
            <Calendar
              aria-label={t({ id: 'ui.date.gallery.german', message: 'German' })}
              defaultValue="2026-09-27"
            />
          </I18nProvider>
          <I18nProvider locale="ar">
            <Calendar
              aria-label={t({ id: 'ui.date.gallery.arabic', message: 'Arabic' })}
              defaultValue="2026-09-27"
            />
          </I18nProvider>
        </>
      ),
    },
  ],
};
