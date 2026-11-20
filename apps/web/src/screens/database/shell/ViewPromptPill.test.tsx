import { cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { ViewPromptPill } from './ViewPromptPill';
import { renderShell } from './test-support';

afterEach(cleanup);
it('stays absent without changes', () => {
  const { container } = renderShell(
    <ViewPromptPill prompts={{ entered: 0, left: new Set(), orderChanged: false }} onRefresh={vi.fn()} />,
  );
  expect(container.childElementCount).toBe(0);
});
it.each([1, 4])(
  'announces %i new records before other changes and refreshes by keyboard',
  async (entered) => {
    const onRefresh = vi.fn();
    renderShell(
      <ViewPromptPill
        prompts={{ entered, left: new Set(['record']), orderChanged: true }}
        onRefresh={onRefresh}
      />,
    );
    const button = screen.getByRole('button', { name: entered === 1 ? '1 new record' : '4 new records' });
    await userEvent.tab();
    expect(document.activeElement).toBe(button);
    await userEvent.keyboard('{Enter}');
    expect(onRefresh).toHaveBeenCalledOnce();
  },
);
it.each([true, false])('announces changes in membership or ordering', (orderChanged) => {
  renderShell(
    <ViewPromptPill
      prompts={{ entered: 0, left: new Set(orderChanged ? [] : ['record']), orderChanged }}
      onRefresh={vi.fn()}
    />,
  );
  expect(screen.getByRole('button', { name: 'View changed' })).toBeDefined();
});
