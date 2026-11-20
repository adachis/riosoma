import { renderSettings as renderSharing } from '../../screens/settings/testing';
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionInfo, TelemetryPayload, TelemetryStatus } from '@riosoma/contracts';
import { json, session } from '../../screens/database/share/testing';
import { TelemetryStep } from '../../screens/setup/TelemetryStep';
import { TelemetrySettings } from './TelemetrySettings';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const payload: TelemetryPayload = {
  schema: 1,
  installId: '5f0c3a52-1d7e-4a8e-9c1b-2f3a4b5c6d7e',
  week: '2026-09-21',
  version: '1.0.0',
  install: 'compose',
  databases: {
    '0': 0,
    '1-99': 2,
    '100-999': 1,
    '1000-9999': 0,
    '10000-99999': 0,
    '100000-999999': 0,
    '1000000+': 0,
  },
  tables: {
    '0': 1,
    '1-99': 4,
    '100-999': 2,
    '1000-9999': 0,
    '10000-99999': 0,
    '100000-999999': 0,
    '1000000+': 0,
  },
  features: { automations: true, singleSignOn: false } as TelemetryPayload['features'],
  uses: { changes: '100-999', rioMessages: '1-9' } as TelemetryPayload['uses'],
};
const ON_ID = '0b7d8e21-6c4a-4f2e-8a9b-1c2d3e4f5a6b';

function telemetry(over: Partial<TelemetryStatus> = {}): TelemetryStatus {
  return {
    forcedOff: false,
    enabled: false,
    url: 'https://hub.example.test/telemetry',
    installId: null,
    preview: payload,
    lastSent: null,
    ...over,
  };
}

function serve(initial: TelemetryStatus) {
  let current = initial;
  const requests: Array<{ url: string; method: string; body?: unknown }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const body = init?.body ? (JSON.parse(String(init.body)) as { enabled: boolean }) : undefined;
      requests.push({ url, method: init?.method ?? 'GET', ...(body ? { body } : {}) });
      // Turning counts on makes the install ID, and turning them off deletes it.
      if (init?.method === 'PUT') {
        const installId = body!.enabled ? ON_ID : null;
        current = {
          ...current,
          enabled: body!.enabled,
          installId,
          preview: { ...payload, installId: installId ?? payload.installId },
        };
      }
      return json(current);
    }),
  );
  return requests;
}

const member: SessionInfo = { ...session, membership: { kind: 'member', adminRoles: ['people'] } };

describe('usage count settings', () => {
  it('show exactly what would be sent, as its JSON, and turn on only when the owner chooses', async () => {
    const requests = serve(telemetry());
    renderSharing(<TelemetrySettings />);
    const preview = await screen.findByLabelText('Exactly what would be sent');
    expect(preview.textContent).toBe(JSON.stringify(payload, null, 2));
    const toggle = screen.getByRole('switch', { name: 'Send anonymous usage counts each week' });
    expect((toggle as HTMLInputElement).checked).toBe(false);
    expect(screen.getByText(/https:\/\/hub\.example\.test\/telemetry/)).toBeDefined();
    // Off, there's no install ID yet, so the one in the preview is an example.
    expect(screen.getByText(/The install ID above is an example\./)).toBeDefined();
    expect(screen.getByText(/There’s no install ID while counts are off\./)).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Get a new install ID' })).toBeNull();
    await userEvent.setup().click(toggle);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(requests.at(-1)).toEqual({
        url: '/api/admin/telemetry',
        method: 'PUT',
        body: { enabled: true },
      }),
    );
    await waitFor(() => expect((toggle as HTMLInputElement).checked).toBe(true));
    expect(screen.getByText(ON_ID)).toBeDefined();
    expect(screen.queryByText(/The install ID above is an example\./)).toBeNull();
    // Getting a new ID says what it does and doesn't do.
    expect(
      screen.getByText(
        'A new ID means later reports can’t be linked to earlier ones by their ID, though the counts themselves may still look like earlier weeks’.',
      ),
    ).toBeDefined();
    expect(screen.getByRole('button', { name: 'Get a new install ID' })).toBeDefined();
  });

  it('show the last payload sent', async () => {
    serve(
      telemetry({
        enabled: true,
        installId: payload.installId,
        lastSent: { at: new Date().toISOString(), delivered: true, payload },
      }),
    );
    renderSharing(<TelemetrySettings />);
    await userEvent.setup().click(await screen.findByRole('button', { name: 'What was sent' }));
    expect((await screen.findByLabelText('The last payload sent')).textContent).toBe(
      JSON.stringify(payload, null, 2),
    );
  });

  it('can’t be turned on when the server’s settings keep them off', async () => {
    serve(telemetry({ forcedOff: true }));
    renderSharing(<TelemetrySettings />);
    expect(await screen.findByText(/keep usage counts off, whatever is chosen here/)).toBeDefined();
    expect((screen.getByRole('switch') as HTMLInputElement).disabled).toBe(true);
  });

  it('are the owner’s alone', () => {
    const requests = serve(telemetry());
    renderSharing(<TelemetrySettings />, member);
    expect(screen.getByText('Only the owner decides whether this server sends usage counts.')).toBeDefined();
    expect(requests).toEqual([]);
  });
});

describe('the usage counts step in setup', () => {
  it('shows the payload and records the owner’s choice before going on', async () => {
    const requests = serve(telemetry());
    const done = vi.fn();
    renderSharing(<TelemetryStep onDone={done} />);
    expect((await screen.findByLabelText('Exactly what would be sent')).textContent).toBe(
      JSON.stringify(payload, null, 2),
    );
    expect(screen.getByText(/The install ID above is an example\./)).toBeDefined();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Don’t send usage counts' }));
    await waitFor(() => expect(done).toHaveBeenCalled());
    expect(requests.at(-1)).toEqual({ url: '/api/admin/telemetry', method: 'PUT', body: { enabled: false } });
  });

  it('is skipped when the server’s settings keep counts off', async () => {
    serve(telemetry({ forcedOff: true }));
    const done = vi.fn();
    renderSharing(<TelemetryStep onDone={done} />);
    await waitFor(() => expect(done).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: 'Send usage counts weekly' })).toBeNull();
  });
});
