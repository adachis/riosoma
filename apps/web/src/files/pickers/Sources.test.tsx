import { cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { renderSharing } from '../../screens/database/share/testing';
import { AddFromMenu } from './AddFromMenu';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('offers scanning for an attachment destination without a camera or a remote download callback', async () => {
  vi.stubGlobal('navigator', { ...navigator, mediaDevices: undefined });
  renderSharing(
    <AddFromMenu
      locale="en-US"
      tableId="tbl00000000000001"
      fieldId="fld00000000000001"
      recordId="rec00000000000001"
      onFiles={() => {}}
      onPicks={() => {}}
    />,
  );
  await userEvent.click(screen.getByRole('button', { name: 'More ways to add' }));
  expect(screen.queryByRole('menuitem', { name: 'Image search' })).toBeNull();
  await userEvent.click(screen.getByRole('menuitem', { name: 'Scan documents' }));
  expect(screen.getByRole('dialog', { name: 'Scan documents' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Use a photo' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Capture page' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Save PDF' }).hasAttribute('disabled')).toBe(true);
});
