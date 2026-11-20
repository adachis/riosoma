import { browser, target } from './browser';
import { Connection, type ApiCall } from './model';
import { IntegrationError, errorKey } from '../../../packages/ui/src/integrations/messages';

const connection = new Connection(
  browser.storage.local,
  browser.storage.session,
  browser.identity,
  browser.permissions,
  target,
);

browser.runtime.onMessage.addListener((input, sender, respond) => {
  if (
    sender.id !== browser.runtime.id ||
    sender.url?.split(/[?#]/)[0] !== browser.runtime.getURL('popup.html')
  )
    return false;
  const run = async () => {
    const request = input as { kind: string; clientId?: string; call?: ApiCall };
    switch (request.kind) {
      case 'session':
        return Boolean(await connection.session());
      case 'signIn':
        return connection.signIn(String(request.clientId ?? ''));
      case 'signOut':
        return connection.signOut();
      case 'api':
        return connection.api(request.call!);
      default:
        throw new IntegrationError('integration.invalid');
    }
  };
  // Errors cross to the popup by message ID, so the popup shows them in its own language.
  void run().then(
    (value) => respond({ value }),
    (error: unknown) => respond({ error: errorKey(error) }),
  );
  return true;
});
