import type { QueryClient } from '@tanstack/react-query';
import type { SessionInfo } from '@riosoma/contracts';
import { sessionQuery } from '../../session';

type SessionListener = (client: QueryClient, session: SessionInfo | null) => void;
let sessionListener: SessionListener | undefined;

export function conversationPerson(session: SessionInfo | null) {
  return session ? `${session.org.id}:${session.user.id}:${session.csrfToken}` : '';
}

export function panelStorageKey(session: SessionInfo | null) {
  // A fresh sign-in gets its own panel state without storing its token.
  let fingerprint = 0;
  for (const char of conversationPerson(session)) fingerprint = (fingerprint * 31 + char.charCodeAt(0)) | 0;
  return `rio.panel.${fingerprint}`;
}

export function savedPanelOpen(session: SessionInfo | null): boolean {
  try {
    const saved = JSON.parse(sessionStorage.getItem(panelStorageKey(session)) ?? 'null') as {
      open?: boolean;
    } | null;
    return saved?.open === true;
  } catch {
    return false;
  }
}

/** The conversation runtime starts observing once the panel has loaded. */
export function observeConversationSessions(listener: SessionListener) {
  sessionListener = listener;
}

export function keepRioToSession(client: QueryClient) {
  return client.getQueryCache().subscribe((event) => {
    if (event.query.queryKey[0] !== sessionQuery.queryKey[0]) return;
    const session = event.query.state.data as SessionInfo | null | undefined;
    if (session !== undefined) sessionListener?.(client, session);
  });
}
