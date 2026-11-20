import { setupI18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { DialogBody, DialogTitle } from '@riosoma/ui';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { RecordShell } from './RecordShell';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each(['card', 'panel', 'page'] as const)(
  'keeps the focused field inside the visible record body in the %s layout',
  async (layout) => {
    const viewport = Object.assign(new EventTarget(), { height: 844, offsetTop: 0 });
    vi.stubGlobal('visualViewport', viewport);
    const i18n = setupI18n({ locale: 'en-US', messages: { 'en-US': {} } });
    const { unmount } = render(
      <I18nProvider i18n={i18n}>
        <RecordShell layout={layout} titleId="record-title" wide={false} onClose={vi.fn()}>
          <DialogTitle id="record-title">Record</DialogTitle>
          <DialogBody className="rio-record-card__body">
            <input aria-label="Last field" />
          </DialogBody>
        </RecordShell>
      </I18nProvider>,
    );
    const input = screen.getByRole('textbox', { name: 'Last field' });
    const body = input.closest<HTMLElement>('.rio-record-card__body')!;
    const bounds = (top: number, bottom: number) => new DOMRect(0, top, 300, bottom - top);
    vi.spyOn(body, 'getBoundingClientRect').mockImplementation(() => bounds(100, viewport.height));
    vi.spyOn(input, 'getBoundingClientRect').mockImplementation(() =>
      bounds(420 - body.scrollTop, 460 - body.scrollTop),
    );
    act(() => input.focus());
    await waitFor(() => expect(document.activeElement).toBe(input));
    body.scrollTop = 0;
    const layoutHeight = window.innerHeight;
    viewport.height = 390;
    act(() => viewport.dispatchEvent(new Event('resize')));
    await waitFor(() => expect(body.scrollTop).toBe(70));
    expect(window.innerHeight).toBe(layoutHeight);
    expect(document.activeElement).toBe(input);

    // Panning the visual viewport can hide the top of a focused field without another resize.
    viewport.offsetTop = 365;
    act(() => viewport.dispatchEvent(new Event('scroll')));
    await waitFor(() => expect(body.scrollTop).toBe(55));

    // Refocusing a field after the keyboard opens must also enter the visible body.
    input.blur();
    body.scrollTop = 0;
    viewport.offsetTop = 0;
    act(() => input.focus());
    await waitFor(() => expect(body.scrollTop).toBe(70));

    unmount();
    body.scrollTop = 0;
    act(() => viewport.dispatchEvent(new Event('resize')));
    await new Promise((resolve) => requestAnimationFrame(resolve));
    expect(body.scrollTop).toBe(0);
  },
);

it('opens a record when the visual viewport API is unavailable', () => {
  vi.stubGlobal('visualViewport', undefined);
  const i18n = setupI18n({ locale: 'en-US', messages: { 'en-US': {} } });
  render(
    <I18nProvider i18n={i18n}>
      <RecordShell layout="page" titleId="record-title" wide={false} onClose={vi.fn()}>
        <DialogTitle id="record-title">Record</DialogTitle>
        <DialogBody>
          <input aria-label="Last field" />
        </DialogBody>
      </RecordShell>
    </I18nProvider>,
  );
  expect(screen.getByRole('textbox', { name: 'Last field' })).toBeTruthy();
});
