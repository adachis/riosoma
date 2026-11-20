import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AutomationConfig, AutomationStep } from '@riosoma/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StepCard } from './StepCard';
import { STEP_KINDS, newStep } from './model';
import { automationFixture, renderWithProviders, type AutomationFixture } from './test-support';

const fixtures: AutomationFixture[] = [];
afterEach(() => {
  cleanup();
  fixtures.splice(0).forEach((fixture) => fixture.session.close());
  vi.unstubAllGlobals();
});

async function mount(step: AutomationStep, readOnly = false) {
  const fixture = await automationFixture();
  fixtures.push(fixture);
  const schema = fixture.session.getSchema();
  const config: AutomationConfig = {
    trigger: { kind: 'recordCreated', tableId: fixture.tasks.id },
    conditions: null,
    steps: [step],
  };
  const onChange = vi.fn();
  const onTest = vi.fn();
  renderWithProviders(
    <StepCard
      step={step}
      index={0}
      config={config}
      schema={schema}
      readOnly={readOnly}
      canDuplicate
      problems={undefined}
      onChange={onChange}
      onTest={onTest}
      onMove={() => {}}
      onDelete={() => {}}
      onDuplicate={() => {}}
    />,
  );
  return { fixture, schema, config, onChange, onTest };
}

describe('messaging editor', () => {
  it.each(['slack', 'teams', 'discord'] as const)(
    'shows a saved %s credential, replaces it, and runs a real test',
    async (kind) => {
      const { onChange, onTest, schema, config, fixture } = await mount({
        id: 'step01',
        name: '',
        kind,
        webhookUrl: '',
        secretSaved: true,
        body: 'Message',
      });
      expect(screen.getByText(/Saved/)).toBeDefined();
      expect(screen.queryByLabelText('Incoming webhook address')).toBeNull();
      await userEvent.click(screen.getByRole('button', { name: 'Replace' }));
      const input = screen.getByLabelText('Incoming webhook address') as HTMLInputElement;
      expect(input.type).toBe('password');
      await userEvent.click(input);
      await userEvent.paste('https://example.org/private-token');
      expect(onChange).toHaveBeenCalledWith(
        expect.objectContaining({ kind, webhookUrl: 'https://example.org/private-token' }),
      );
      await userEvent.click(screen.getByRole('button', { name: 'Test step' }));
      expect(onTest).toHaveBeenCalledOnce();
      expect(STEP_KINDS).toContain(kind);
      expect(newStep(kind, config, 0, schema, fixture.tasks.id)).toMatchObject({
        kind,
        webhookUrl: '',
        body: '',
      });
      expect(screen.getByRole('textbox', { name: 'Message' })).toBeDefined();
      expect(screen.getAllByRole('button', { name: 'Insert a value' }).length).toBeGreaterThan(0);
    },
  );

  it('shows saved credentials without edit controls to readers', async () => {
    await mount(
      { id: 'step01', name: '', kind: 'discord', webhookUrl: '', secretSaved: true, body: 'Message' },
      true,
    );
    expect(screen.getByText(/Saved/)).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Replace' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Test step' })).toBeNull();
  });

  it('explains SMS charges and changes the organization setting', async () => {
    const fetch = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) =>
        new Response(JSON.stringify({ smsEnabled: init?.method === 'PUT' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetch);
    await mount({
      id: 'step01',
      name: '',
      kind: 'sms',
      accountSid: `AC${'1'.repeat(32)}`,
      authToken: '',
      secretSaved: true,
      from: '+15005550006',
      to: '+15005550009',
      body: 'Message',
    });
    expect(screen.getByText(/SMS costs money/)).toBeDefined();
    const toggle = await screen.findByRole('switch', { name: 'Allow SMS for this organization' });
    expect((toggle as HTMLInputElement).checked).toBe(false);
    await userEvent.click(toggle);
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        '/api/admin/automations/messaging',
        expect.objectContaining({ method: 'PUT', body: JSON.stringify({ smsEnabled: true }) }),
      ),
    );
    expect(screen.getByLabelText('Sending number')).toBeDefined();
    expect(screen.getByLabelText('Account SID')).toBeDefined();
    expect(screen.getByRole('textbox', { name: 'To' })).toBeDefined();
    expect(screen.queryByLabelText('Auth token')).toBeNull();
  });
});
