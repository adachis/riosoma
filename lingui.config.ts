import { defineConfig } from '@lingui/conf';
import { formatter } from '@lingui/format-po';

/**
 * One message catalog for the whole app.  Every string has an explicit key (`setup.database.title`)
 * and its American English source text beside it in code; extraction collects them from the web
 * app, the shared UI packages, and the emails, documents, and site pages the server writes into one
 * catalog per locale.
 */
export default defineConfig({
  sourceLocale: 'en-US',
  locales: ['en-US', 'es', 'fr', 'de', 'it', 'pt-BR', 'nl', 'ja', 'ko', 'zh-Hans', 'zh-Hant', 'en-XA'],
  pseudoLocale: 'en-XA',
  fallbackLocales: { default: 'en-US' },
  catalogs: [
    {
      path: '<rootDir>/apps/web/src/locales/{locale}/messages',
      include: [
        '<rootDir>/apps/web/src',
        '<rootDir>/packages/ui/src',
        '<rootDir>/packages/rio/src',
        '<rootDir>/apps/server/src/reports/email.ts',
        '<rootDir>/apps/server/src/bookings/email.ts',
        '<rootDir>/apps/server/src/data/export/office/copy.ts',
        '<rootDir>/apps/server/src/sites/render.ts',
      ],
      exclude: ['**/*.test.tsx', '**/*.gallery.tsx', '**/node_modules/**'],
    },
  ],
  // Sorted by key: sorting by English text breaks ties (two messages reading "Appearance")
  // differently from one machine to the next.
  orderBy: 'messageId',
  format: formatter({ lineNumbers: false }),
});
