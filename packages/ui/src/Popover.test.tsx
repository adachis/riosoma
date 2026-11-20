import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Dialog, DialogTrigger, Heading } from 'react-aria-components';
import { describe, expect, it } from 'vitest';
import { Button } from './Button';
import { Popover } from './Popover';

function surface() {
  return document.querySelector('.rio-popover');
}

describe('Popover', () => {
  it('opens from its trigger and closes on Escape', async () => {
    render(
      <DialogTrigger>
        <Button>Filters</Button>
        <Popover placement="bottom">
          <p>Only failed queries</p>
        </Popover>
      </DialogTrigger>,
    );
    expect(surface()).toBeNull();

    const trigger = screen.getByRole('button', { name: 'Filters' });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    await userEvent.click(trigger);
    const popover = await screen.findByRole('dialog');
    expect(popover).toBe(surface());
    expect(popover.textContent).toContain('Only failed queries');
    // The trigger points at the surface it opened, so the two stay tied together.
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(popover.id).toBe(trigger.getAttribute('aria-controls'));

    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(surface()).toBeNull();
  });

  it('opens from the keyboard and takes focus', async () => {
    render(
      <DialogTrigger>
        <Button>Filters</Button>
        <Popover>
          <p>Only failed queries</p>
        </Popover>
      </DialogTrigger>,
    );
    screen.getByRole('button', { name: 'Filters' }).focus();
    await userEvent.keyboard('{Enter}');

    const popover = await screen.findByRole('dialog');
    expect(popover.contains(document.activeElement)).toBe(true);
  });

  it('closes on a press outside', async () => {
    render(
      <DialogTrigger>
        <Button>Filters</Button>
        <Popover>
          <p>Only failed queries</p>
        </Popover>
      </DialogTrigger>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Filters' }));
    await screen.findByRole('dialog');

    await userEvent.click(document.body);
    expect(surface()).toBeNull();
  });

  it('keeps the placement it is given', async () => {
    render(
      <DialogTrigger>
        <Button>Filters</Button>
        <Popover placement="top">
          <p>Only failed queries</p>
        </Popover>
      </DialogTrigger>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Filters' }));
    expect((await screen.findByRole('dialog')).getAttribute('data-placement')).toBe('top');
  });

  it('accepts the positioning props', async () => {
    render(
      <DialogTrigger>
        <Button>Filters</Button>
        <Popover placement="bottom" offset={20} crossOffset={4}>
          <p>Only failed queries</p>
        </Popover>
      </DialogTrigger>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Filters' }));
    expect(await screen.findByRole('dialog')).toBeTruthy();
  });

  it('draws an arrow only when asked', async () => {
    const { rerender } = render(
      <DialogTrigger>
        <Button>Filters</Button>
        <Popover>
          <p>Only failed queries</p>
        </Popover>
      </DialogTrigger>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Filters' }));
    await screen.findByRole('dialog');
    expect(document.querySelector('.rio-popover__arrow')).toBeNull();

    await userEvent.keyboard('{Escape}');
    rerender(
      <DialogTrigger>
        <Button>Filters</Button>
        <Popover arrow>
          <p>Only failed queries</p>
        </Popover>
      </DialogTrigger>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Filters' }));
    await screen.findByRole('dialog');
    const arrow = document.querySelector('.rio-popover__arrow');
    expect(arrow).not.toBeNull();
    // The arrow only ties the surface to its trigger, so it is hidden from assistive technology.
    expect(arrow?.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('is named by the dialog inside it', async () => {
    render(
      <DialogTrigger>
        <Button>Filters</Button>
        <Popover arrow>
          <Dialog>
            <Heading slot="title">Filters</Heading>
            <p>Only failed queries</p>
          </Dialog>
        </Popover>
      </DialogTrigger>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Filters' }));
    expect(await screen.findByRole('dialog', { name: 'Filters' })).toBeTruthy();
    // One dialog, not a surface wrapped around another one.
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
  });

  it('hands its render props to children', async () => {
    render(
      <DialogTrigger>
        <Button>Filters</Button>
        <Popover placement="bottom">{({ placement }) => <p>placed {placement ?? 'nowhere'}</p>}</Popover>
      </DialogTrigger>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Filters' }));
    expect(await screen.findByText('placed bottom')).toBeTruthy();
  });
});
