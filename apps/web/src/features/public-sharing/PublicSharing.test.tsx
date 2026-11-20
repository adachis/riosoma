import { renderSettings as renderSharing } from '../../screens/settings/testing';
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { newId, PublicSharingCommand, PublicSharingPolicy, SharedViewEmbed } from '@riosoma/contracts';
import { json } from '../../screens/database/share/testing';
import { PublicSharingSettings } from './PublicSharingSettings';
import { EmbedPanel } from './EmbedPanel';
import { FormFilesPanel } from './FormFilesPanel';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it('saves organization controls through a validated command and rejects an invalid lifetime', async () => {
  const user = userEvent.setup();
  let policy = PublicSharingPolicy.parse({});
  const commands: PublicSharingCommand[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, options?: RequestInit) => {
      if (options?.method === 'POST') {
        const command = PublicSharingCommand.parse(JSON.parse(String(options.body)));
        commands.push(command);
        if (command.action?.kind === 'policy') policy = command.action.policy;
        return json({ status: 'applied', id: command.id });
      }
      return json(policy);
    }),
  );
  renderSharing(<PublicSharingSettings />);
  await user.click(await screen.findByRole('switch', { name: 'Allow signed public file links' }));
  const lifetime = screen.getByRole('spinbutton', { name: 'File link lifetime in seconds' });
  await user.clear(lifetime);
  await user.type(lifetime, '5');
  expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(false);
  await user.click(screen.getByRole('button', { name: 'Save' }));
  expect(commands).toEqual([]);
  await user.clear(lifetime);
  await user.type(lifetime, '120');
  await user.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(commands).toHaveLength(1));
  expect(policy).toEqual({ embeddingEnabled: true, publicFiles: true, fileLifetimeSeconds: 120 });
  await screen.findByText('Saved public sharing settings');
});

it.each(['form', 'booking'] as const)(
  'saves exact embed origins for a %s and supplies titled frame code',
  async (kind) => {
    const user = userEvent.setup();
    let embed = SharedViewEmbed.parse({});
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, options?: RequestInit) => {
        if (options?.method === 'POST') {
          const command = PublicSharingCommand.parse(JSON.parse(String(options.body)));
          if (command.action?.kind === 'embed') embed = command.action.embed;
          return json({ status: 'applied', id: command.id });
        }
        return json({ embed, embeddingEnabled: true });
      }),
    );
    renderSharing(
      <EmbedPanel target={{ kind, linkId: 'A'.repeat(22) }} url={`/f/${'A'.repeat(22)}`} name="Intake" />,
    );
    await user.click(await screen.findByRole('switch', { name: 'Allow embedding on other sites' }));
    const sites = await screen.findByRole('textbox', { name: 'Sites that may embed it' });
    await user.type(sites, 'https://example.test');
    await user.click(screen.getByRole('button', { name: 'Save sites' }));
    // Saving leaves nothing to save, so the button disables itself.  The focus stays in the list
    // rather than falling out of the dialog, where Escape would have nothing left to close.
    expect(document.activeElement).toBe(sites);
    await waitFor(() => expect(embed.sites).toEqual(['https://example.test']));
    expect((screen.getByRole('textbox', { name: 'Embed code' }) as HTMLTextAreaElement).value).toContain(
      'title="Intake"',
    );
  },
);

it('lets an owner select supporting files by name', async () => {
  const user = userEvent.setup();
  const fileId = newId('attachment');
  let selected: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, options?: RequestInit) => {
      if (options?.method === 'POST') {
        const command = PublicSharingCommand.parse(JSON.parse(String(options.body)));
        if (command.action?.kind === 'formFiles') selected = command.action.fileIds;
        return json({ status: 'applied', id: command.id });
      }
      return json({ selected, files: [{ id: fileId, name: 'Instructions.pdf' }] });
    }),
  );
  renderSharing(<FormFilesPanel formId={'A'.repeat(22)} />);
  await user.click(await screen.findByRole('checkbox', { name: 'Instructions.pdf' }));
  await waitFor(() => expect(selected).toEqual([fileId]));
});
