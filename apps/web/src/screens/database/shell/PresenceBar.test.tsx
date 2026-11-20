import { cleanup, fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it } from 'vitest';
import type { PresencePeer } from '@riosoma/contracts';
import { PresenceBar } from './PresenceBar';
import { renderShell } from './test-support';

afterEach(cleanup);
it('shows one avatar per person, including people with the same name, and name tooltips', async () => {
  const peer: PresencePeer = {
    clientId: 'tab-1',
    userId: 'person-1',
    name: 'Avery Smith',
    color: 'blue',
    where: null,
  };
  renderShell(
    <PresenceBar
      peers={[peer, { ...peer, clientId: 'tab-2' }, { ...peer, clientId: 'tab-3', userId: 'person-2' }]}
    />,
  );
  expect(screen.getByRole('group', { name: 'People here' })).toBeDefined();
  const avatars = screen.getAllByRole('img', { name: 'AS: Avery Smith' });
  expect(avatars).toHaveLength(2);
  fireEvent.pointerMove(avatars[0]!);
  await userEvent.hover(avatars[0]!);
  expect((await screen.findByRole('tooltip')).textContent).toBe('Avery Smith');
});
it('shows every person and handles empty presence', () => {
  const { rerender } = renderShell(
    <PresenceBar
      peers={Array.from({ length: 6 }, (_, index) => ({
        clientId: `tab-${index}`,
        userId: `person-${index}`,
        name: `Person ${index}`,
        color: 'blue',
        where: null,
      }))}
    />,
  );
  expect(screen.getAllByRole('img')).toHaveLength(6);
  rerender(<PresenceBar peers={[]} />);
  expect(screen.queryAllByRole('img')).toHaveLength(0);
});
