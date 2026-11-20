import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Banner } from './Banner';
import { render } from './test/render';

describe('Banner', () => {
  it('shows a title and body in a polite live region for info', () => {
    render(
      <Banner tone="info" title="Nightly backup moved">
        Backups now start at 02:00 local time.
      </Banner>,
    );
    const banner = screen.getByRole('status');
    expect(banner.getAttribute('data-variant')).toBe('info');
    expect(banner.textContent).toContain('Nightly backup moved');
    expect(banner.textContent).toContain('Backups now start at 02:00 local time.');
  });

  it('announces warning and danger banners as alerts', () => {
    render(
      <>
        <Banner tone="warning" title="Disk almost full">
          92% of the data volume is used.
        </Banner>
        <Banner tone="danger" title="Replication stopped">
          The replica is 4 hours behind.
        </Banner>
      </>,
    );
    const alerts = screen.getAllByRole('alert');
    expect(alerts).toHaveLength(2);
    expect(alerts[0]?.getAttribute('data-variant')).toBe('warning');
    expect(alerts[1]?.getAttribute('data-variant')).toBe('danger');
    expect(screen.queryByRole('status')).toBe(null);
  });

  it('names itself by its title and keeps the icon decorative', () => {
    const { container } = render(
      <Banner tone="success" title="Restore finished">
        Every table is back online.
      </Banner>,
    );
    const banner = screen.getByRole('status');
    expect(banner.getAttribute('aria-labelledby')).toBeTruthy();
    expect(screen.getByText('Restore finished').id).toBe(banner.getAttribute('aria-labelledby'));
    const icon = container.querySelector('.rio-banner__icon');
    expect(icon?.getAttribute('aria-hidden')).toBe('true');
  });

  it('has no dismiss button unless the caller asks for one', () => {
    render(<Banner tone="info">The connection pool was resized.</Banner>);
    expect(screen.queryByRole('button')).toBe(null);
  });

  it('dismisses on click and tells the caller', async () => {
    const onDismiss = vi.fn();
    render(
      <Banner tone="info" title="Maintenance window" onDismiss={onDismiss}>
        Sunday, 03:00 to 04:00.
      </Banner>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(onDismiss).toHaveBeenCalledOnce();
    expect(screen.queryByRole('status')).toBe(null);
  });

  it('dismisses from the keyboard', async () => {
    const user = userEvent.setup();
    render(
      <Banner tone="danger" title="Replication stopped" onDismiss={() => undefined}>
        The replica is 4 hours behind.
      </Banner>,
    );
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Dismiss' }));
    await user.keyboard('{Enter}');
    expect(screen.queryByRole('alert')).toBe(null);
  });

  it('drops the icon when asked to', () => {
    const { container } = render(
      <Banner tone="info" icon={null}>
        No icon here.
      </Banner>,
    );
    expect(container.querySelector('.rio-banner__icon')).toBe(null);
    expect(screen.getByRole('status').textContent).toBe('No icon here.');
  });
});
