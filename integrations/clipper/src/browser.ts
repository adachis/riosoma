import type { Target } from './manifest';
import type { HostAccess, Identity, Store } from './model';

export interface Browser {
  storage: { local: Store; session: Store };
  identity: Identity;
  permissions: HostAccess & { request(permissions: { origins: string[] }): Promise<boolean> };
  i18n: { getUILanguage(): string };
  runtime: {
    id: string;
    getURL(path: string): string;
    sendMessage(message: unknown): Promise<{ value?: unknown; error?: string }>;
    onMessage: {
      addListener(
        listener: (
          message: unknown,
          sender: { id?: string; url?: string },
          respond: (value: unknown) => void,
        ) => boolean,
      ): void;
    };
  };
  tabs: {
    query(query: {
      active: boolean;
      currentWindow: boolean;
    }): Promise<{ id?: number; windowId: number; title?: string; url?: string }[]>;
    captureVisibleTab(windowId: number, options: { format: 'png' }): Promise<string>;
  };
  scripting: {
    executeScript(options: { target: { tabId: number }; func: () => string }): Promise<{ result?: string }[]>;
  };
}
export const browser =
  (globalThis as unknown as { browser?: Browser; chrome: Browser }).browser ??
  (globalThis as unknown as { chrome: Browser }).chrome;

/** Firefox serves extension pages from moz-extension: addresses, and its match patterns carry no port. */
export const target: Target = browser.runtime.getURL('').startsWith('moz-extension:') ? 'firefox' : 'chrome';
