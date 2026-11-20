import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { CODE_FRAME_DOCUMENT } from './code-frame.js';

const bootstrap = CODE_FRAME_DOCUMENT.split('<script>')[1]!.split('</script>')[0]!;

describe('custom code frame bootstrap', () => {
  it('removes WebRTC entry points immutably before announcing the bridge', () => {
    const inherited = { RTCIceTransport: () => undefined };
    const window = Object.assign(Object.create(inherited), {
      RTCPeerConnection: () => undefined,
      webkitRTCPeerConnection: () => undefined,
      mozRTCPeerConnection: () => undefined,
      RTCTransport: () => undefined,
    });
    const ready = vi.fn(() => {
      for (const target of [window, inherited]) {
        for (const name of Object.getOwnPropertyNames(target)) {
          expect(target[name]).toBeUndefined();
          expect(Reflect.set(target, name, () => undefined)).toBe(false);
          expect(Reflect.deleteProperty(target, name)).toBe(false);
        }
      }
    });
    runInNewContext(bootstrap, { window, parent: { postMessage: ready }, addEventListener: vi.fn() });
    expect(ready).toHaveBeenCalledWith({ type: 'interface-code-ready' }, '*');
  });

  it('never exposes the bridge when a WebRTC entry point cannot be disabled', () => {
    const window = Object.defineProperty({}, 'RTCPeerConnection', { value: () => undefined });
    const ready = vi.fn();
    const listen = vi.fn();
    expect(() =>
      runInNewContext(bootstrap, { window, parent: { postMessage: ready }, addEventListener: listen }),
    ).toThrow();
    expect(ready).not.toHaveBeenCalled();
    expect(listen).not.toHaveBeenCalled();
  });
});
