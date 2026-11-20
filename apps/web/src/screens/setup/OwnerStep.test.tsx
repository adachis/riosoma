import { randomBytes } from 'node:crypto';
import { cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { json, renderSharing, session } from '../database/share/testing';
import { OwnerStep } from './OwnerStep';
import { useSetupFlow } from './useSetup';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function OwnerForm() {
  return <OwnerStep flow={useSetupFlow()} defaultLocale="en-US" />;
}

it('lets the owner correct a rejected organization name and resubmit', async () => {
  const submitted: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, options?: RequestInit) => {
      if (url === '/api/setup/status') return json({ stage: 'owner', databaseManaged: true });
      const { orgName } = JSON.parse(String(options?.body));
      submitted.push(orgName);
      return orgName.length > 120
        ? json(
            {
              error: {
                code: 'validation_failed',
                messageKey: 'errors.validationFailed',
                userFault: true,
                fields: { orgName: 'validation.too_big' },
              },
            },
            422,
          )
        : json(session);
    }),
  );
  renderSharing(<OwnerForm />, null);
  const user = userEvent.setup();
  const organization = screen.getByLabelText('Organization name');
  await user.type(organization, '長'.repeat(121));
  await user.type(screen.getByLabelText('Your name'), 'Owner');
  await user.type(screen.getByLabelText('Email address'), 'owner@example.test');
  await user.type(screen.getByLabelText(/^Password/), randomBytes(24).toString('base64url'));
  await user.click(screen.getByRole('button', { name: 'Create account' }));
  await screen.findByText('This is too long.');
  await user.clear(organization);
  await user.type(organization, '資料 📚 مكتبة');
  expect(organization.getAttribute('aria-invalid')).not.toBe('true');
  await user.click(screen.getByRole('button', { name: 'Create account' }));
  expect(submitted).toEqual(['長'.repeat(121), '資料 📚 مكتبة']);
});
