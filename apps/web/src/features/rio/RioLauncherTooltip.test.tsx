import { cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useLingui } from '@lingui/react/macro';
import { afterEach, expect, it } from 'vitest';
import { Button } from '@riosoma/ui';
import { renderSharing } from '../../screens/database/share/testing';

afterEach(cleanup);

function Actions() {
  const { t } = useLingui();
  return (
    <>
      <Button tooltip aria-label={t({ id: 'rio.open', message: 'AI: Ask Rio' })} />
      <Button aria-label={t({ id: 'shell.personalMenu', message: 'Personal menu' })} />
    </>
  );
}

it('removes the launcher tooltip when focus moves to another control', async () => {
  renderSharing(<Actions />);
  const user = userEvent.setup();
  await user.tab();
  expect(await screen.findByRole('tooltip')).toBeTruthy();
  await user.tab();
  expect(screen.queryByRole('tooltip')).toBeNull();
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Personal menu' }));
});
