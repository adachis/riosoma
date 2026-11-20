import type { Page } from '@playwright/test';
import type { FileSettingsView } from '../../packages/contracts/src/data/files.js';
import { asOwner } from './helpers';

/** Setup and cleanup use the latest policy, while browser drafts keep their captured revision. */
export async function saveUploadPolicy(page: Page, maxUploadBytes: number | null) {
  const { revision } = await asOwner<FileSettingsView>(page, 'GET', '/api/org/files');
  return asOwner(page, 'POST', '/api/org/admin-commands', {
    kind: 'organization.files',
    maxUploadBytes,
    revision,
  });
}
