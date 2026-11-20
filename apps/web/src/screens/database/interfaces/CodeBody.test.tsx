import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { DatabaseSession } from '../../../data/types';
import { CodeBody } from './CodeBody';
import * as bridge from './code-bridge';
import type { BlockContext } from './context';
import { closeAll, everyBlock, interfaceFixture } from './test-support';

const sessions: DatabaseSession[] = [];
afterEach(() => {
  cleanup();
  closeAll(sessions);
  vi.restoreAllMocks();
});

it('initializes only its opaque frame and sends only that frame its authorized request results', async () => {
  i18n.load('en-US', {});
  i18n.activate('en-US');
  const setup = await interfaceFixture({ blocks: everyBlock });
  sessions.push(setup.session);
  const context: BlockContext = {
    session: setup.session,
    schema: setup.session.getSchema(),
    interfaceId: setup.value.id,
    page: setup.value.pages[0]!,
    canEditRecords: false,
    format: { locale: 'en-US', timeZone: 'UTC', collaborators: setup.session.getSchema().collaborators },
    filters: {},
    selected: {},
    onFilter: vi.fn(),
    onSelect: vi.fn(),
    onMissing: vi.fn(),
    summaries: new Map(),
    onRetry: vi.fn(),
  };
  const code = { html: '<p>Panel</p>', css: '', javascript: '' };
  // Supply the frame window explicitly: Happy DOM keeps iframe loading disabled, and this test
  // exercises the message bridge without fetching or executing a frame document.
  const frameWindow = { postMessage: vi.fn() } as unknown as Window;
  vi.spyOn(HTMLIFrameElement.prototype, 'contentWindow', 'get').mockReturnValue(frameWindow);
  vi.spyOn(HTMLIFrameElement.prototype, 'src', 'get').mockReturnValue('about:blank');
  render(
    <I18nProvider i18n={i18n}>
      <CodeBody code={code} name="Panel" context={context} />
    </I18nProvider>,
  );
  const frame = screen.getByTitle('Panel') as HTMLIFrameElement;
  expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
  const source = frame.contentWindow!;
  const post = vi.spyOn(source, 'postMessage').mockImplementation(() => undefined);
  const outsider = vi.spyOn(window, 'postMessage').mockImplementation(() => undefined);
  const receive = (data: unknown, sender: Window | null = source, origin = 'null') =>
    window.dispatchEvent(new MessageEvent('message', { source: sender, origin, data }));
  const ready = { type: 'interface-code-ready' };
  receive(ready, window);
  receive(ready, null);
  receive(ready, source, location.origin);
  expect(post).not.toHaveBeenCalled();
  expect(outsider).not.toHaveBeenCalled();

  receive(ready);
  expect(post).toHaveBeenCalledExactlyOnceWith(
    { type: 'interface-code-init', channel: expect.any(String), code, locale: 'en-US' },
    '*',
  );
  const channel = (post.mock.calls[0]![0] as { channel: string }).channel;
  const result = { rows: [{ id: setup.fixture.recordId(0) }] };
  const request = vi.spyOn(bridge, 'codeRequest').mockResolvedValue(result);
  const call = {
    type: 'interface-code-call',
    channel,
    id: 1,
    request: { method: 'records', blockId: 'blkRecords01' },
  };
  receive(call, window);
  receive(call, null);
  receive(call, source, location.origin);
  receive({ ...call, channel: 'unrelated' });
  expect(request).not.toHaveBeenCalled();
  expect(post).toHaveBeenCalledTimes(1);

  receive(call);
  await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
  expect(request).toHaveBeenCalledExactlyOnceWith(context, call.request, expect.any(Function), false);
  expect(post).toHaveBeenLastCalledWith(
    { type: 'interface-code-result', channel, id: 1, value: result, error: undefined },
    '*',
  );
  expect(outsider).not.toHaveBeenCalled();
});
