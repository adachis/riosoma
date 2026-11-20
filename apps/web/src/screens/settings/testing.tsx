import type { ReactNode } from 'react';
import type { SessionInfo } from '@riosoma/contracts';
import { renderSharing, session } from '../database/share/testing';
import { SettingsDraftPage, SettingsDraftProvider, SettingsSaveBar } from './SettingsDraft';

export function SettingsTestPage({ children }: { children: ReactNode }) {
  return (
    <SettingsDraftProvider>
      <SettingsDraftPage page="test">
        <div className="rio-settings__content">{children}</div>
      </SettingsDraftPage>
      <footer className="rio-shell__footer">
        <SettingsSaveBar />
      </footer>
    </SettingsDraftProvider>
  );
}

export function renderSettings(children: ReactNode, identity: SessionInfo | null = session) {
  return renderSharing(<SettingsTestPage>{children}</SettingsTestPage>, identity);
}
