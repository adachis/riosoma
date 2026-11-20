import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { TestSteps } from './TestSteps';

afterEach(cleanup);

describe('source test permission notes', () => {
  it('shows every skipped object and its declared permissions in a passing test', () => {
    render(
      <I18nProvider i18n={i18n}>
        <TestSteps
          result={{
            ok: true,
            steps: [
              {
                step: 'rows',
                status: 'skipped',
                ms: 0,
                messageKey: 'sources.app.objectNotAllowed',
                params: { object: 'tickets', permission: 'tickets-read', hasPermission: true },
              },
              {
                step: 'rows',
                status: 'skipped',
                ms: 0,
                messageKey: 'sources.app.objectNotAllowed',
                params: { object: 'products', permission: '', hasPermission: false },
              },
            ],
          }}
        />
      </I18nProvider>,
    );
    expect(screen.getByText('Connected.')).toBeTruthy();
    expect(
      screen.getByText('The key cannot read tickets.  Required permissions: tickets-read.', {
        normalizer: (text) => text,
      }),
    ).toBeTruthy();
    expect(screen.getByText('The key cannot read products.')).toBeTruthy();
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });
});
