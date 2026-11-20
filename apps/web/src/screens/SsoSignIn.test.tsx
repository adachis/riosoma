import { cleanup, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SsoButton } from '@riosoma/contracts';
import { json, renderSharing } from './database/share/testing';
import { SsoSignIn, ssoStartHref } from './SsoSignIn';

const okta: SsoButton = { id: 'OktaProvider0001', kind: 'saml', name: 'Okta' };
const google: SsoButton = { id: 'GoogleProvider01', kind: 'google', name: 'Google' };

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('SsoSignIn with a SAML identity provider', () => {
  it('shows its button like the others, starting at its own address', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json([okta, google])),
    );
    renderSharing(<SsoSignIn next="/settings/people?tab=1" />, null);
    const saml = await screen.findByRole('link', { name: 'Continue with Okta' });
    expect(saml.getAttribute('href')).toBe(
      '/api/auth/saml/OktaProvider0001/start?next=%2Fsettings%2Fpeople%3Ftab%3D1',
    );
    const oidc = screen.getByRole('link', { name: 'Continue with Google' });
    expect(oidc.getAttribute('href')).toBe(
      '/api/auth/sso/GoogleProvider01/start?next=%2Fsettings%2Fpeople%3Ftab%3D1',
    );
    expect(saml.className).toBe(oidc.className);
  });

  it('leaves the return address off when there is none', () => {
    expect(ssoStartHref('OktaProvider0001', undefined, 'saml')).toBe('/api/auth/saml/OktaProvider0001/start');
    expect(ssoStartHref('OktaProvider0001', '/', 'saml')).toBe('/api/auth/saml/OktaProvider0001/start');
    expect(ssoStartHref('AcmeProvider0001', undefined)).toBe('/api/auth/sso/AcmeProvider0001/start');
  });
});
