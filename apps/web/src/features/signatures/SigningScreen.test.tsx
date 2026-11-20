import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import type { PublicSignatureRequest } from '@riosoma/contracts';
import { failure, json, renderSharing } from '../../screens/database/share/testing';
import { SigningScreen } from './SigningScreen';

const originalFonts = Object.getOwnPropertyDescriptor(document, 'fonts');
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (originalFonts) Object.defineProperty(document, 'fonts', originalFonts);
  else Reflect.deleteProperty(document, 'fonts');
  window.history.replaceState(null, '', '/');
});

function setup() {
  const setAttribute = HTMLIFrameElement.prototype.setAttribute;
  vi.spyOn(HTMLIFrameElement.prototype, 'setAttribute').mockImplementation(function (
    this: HTMLIFrameElement,
    name,
    value,
  ) {
    if (name !== 'src') setAttribute.call(this, name, value);
  });
  const token = ['signing', 'tok', 'en', crypto.randomUUID()].join('-');
  window.history.replaceState(null, '', `/signatures#${token}`);
  const preview: PublicSignatureRequest = {
    name: 'agreement.pdf',
    message: 'Please review the agreement.',
    signerName: 'Jamie Park',
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    consent: 'I agree to sign this document electronically.',
    pages: [{ width: 612, height: 792 }],
    signers: [
      { name: 'Jamie Park', signed: false },
      { name: 'Morgan Lee', signed: true },
    ],
    fields: [
      { id: 'signature', signer: 0, kind: 'signature', page: 0, x: 0.1, y: 0.1, width: 0.4, height: 0.1 },
      { id: 'answer', signer: 0, kind: 'text', page: 0, x: 0.1, y: 0.3, width: 0.4, height: 0.1 },
    ],
    otherFields: [{ page: 0, x: 0.1, y: 0.6, width: 0.4, height: 0.1, signerName: 'Morgan Lee' }],
  };
  const posted: Array<{ url: string; body: Record<string, unknown> }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        posted.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
        return json({ ok: true });
      }
      return json(preview);
    }),
  );
  renderSharing(<SigningScreen />, null);
  return { token, preview, posted };
}

it('requires every field and consent, then submits the exact displayed agreement', async () => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    fillText: vi.fn(),
  } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(
    `data:image/png;base64,${btoa(['signature', 'pixels'].join(''))}`,
  );
  Object.defineProperty(document, 'fonts', {
    configurable: true,
    value: { load: vi.fn().mockResolvedValue([]) },
  });
  const { preview, posted } = setup();
  const finish = await screen.findByRole('button', { name: 'Agree and finish signing' });
  expect((finish as HTMLButtonElement).disabled).toBe(true);
  await userEvent.type(screen.getByRole('textbox', { name: 'Your name' }), 'Jamie Park');
  await userEvent.click(screen.getByRole('button', { name: 'Sign' }));
  await screen.findByRole('img', { name: 'Your signature preview' });
  await userEvent.click(screen.getByRole('button', { name: 'Next field' }));
  await userEvent.type(screen.getByRole('textbox', { name: 'Text box' }), 'Approved');
  expect((finish as HTMLButtonElement).disabled).toBe(true);
  await userEvent.click(screen.getByRole('checkbox', { name: preview.consent }));
  await userEvent.click(finish);
  await screen.findByText(/Your signature has been recorded/);
  expect(posted).toHaveLength(1);
  expect(posted[0]!.body).toMatchObject({
    consent: true,
    consentText: preview.consent,
    values: { answer: { text: 'Approved' }, signature: { text: 'Jamie Park' } },
  });
});

it('sends the signer’s time zone, says whose outlined fields are whose, and caps text answers at 500', async () => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    fillText: vi.fn(),
  } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(
    `data:image/png;base64,${btoa(['signature', 'pixels'].join(''))}`,
  );
  Object.defineProperty(document, 'fonts', {
    configurable: true,
    value: { load: vi.fn().mockResolvedValue([]) },
  });
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const { preview, posted } = setup();
  expect(
    await screen.findByText(/Outlined fields marked “For” another name belong to the other signers/),
  ).toBeTruthy();
  await userEvent.type(screen.getByRole('textbox', { name: 'Your name' }), 'Jamie Park');
  await userEvent.click(screen.getByRole('button', { name: 'Sign' }));
  await screen.findByRole('img', { name: 'Your signature preview' });
  await userEvent.click(screen.getByRole('button', { name: 'Next field' }));
  const answer = screen.getByRole('textbox', { name: 'Text box' }) as HTMLTextAreaElement;
  expect(answer.maxLength).toBe(500);
  await userEvent.type(answer, 'Approved');
  await userEvent.click(screen.getByRole('checkbox', { name: preview.consent }));
  await userEvent.click(screen.getByRole('button', { name: 'Agree and finish signing' }));
  await waitFor(() => expect(posted).toHaveLength(1));
  expect(posted[0]!.body.timeZone).toBe(zone);
});

it('requires a decline reason and explicit confirmation', async () => {
  const { posted } = setup();
  await userEvent.click(await screen.findByRole('button', { name: 'Decline to sign' }));
  const confirm = screen.getByRole('button', { name: 'Confirm decline' });
  expect((confirm as HTMLButtonElement).disabled).toBe(true);
  expect(posted).toHaveLength(0);
  await userEvent.type(
    screen.getByRole('textbox', { name: 'Reason for declining' }),
    'The amount needs updating.',
  );
  await userEvent.click(confirm);
  await waitFor(() => expect(posted).toHaveLength(1));
  expect(posted[0]!.url).toContain('/decline?');
  expect(posted[0]!.body).toEqual({ reason: 'The amount needs updating.' });
  await screen.findByText('You declined this request.');
});

it('follows a second link opened in the same tab, and starts over on that request', async () => {
  const { preview } = setup();
  await screen.findByRole('heading', { name: 'Sign agreement.pdf', level: 1 });
  await userEvent.click(screen.getByRole('button', { name: 'Decline to sign' }));
  await userEvent.type(screen.getByRole('textbox', { name: 'Reason for declining' }), 'Not this one.');
  const asked: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      asked.push(url);
      return json({ ...preview, name: 'lease.pdf' });
    }),
  );
  // Another link to the same page differs only after the #, so the browser doesn't load it again.
  const next = ['second', 'tok', 'en', crypto.randomUUID()].join('-');
  window.location.hash = next;
  await screen.findByRole('heading', { name: 'Sign lease.pdf', level: 1 });
  expect(asked.some((url) => url.includes(`token=${encodeURIComponent(next)}`))).toBe(true);
  // Nothing typed for the first request carries over to the second.
  expect(screen.queryByRole('textbox', { name: 'Reason for declining' })).toBeNull();
});

it('names the page plainly when its link is unavailable', async () => {
  window.history.replaceState(null, '', '/signatures#spent');
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => failure('signatures.unavailable', 404)),
  );
  renderSharing(<SigningScreen />, null);
  expect(await screen.findByText(/This signing request is unavailable\./)).toBeTruthy();
  expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Signing request');
});
