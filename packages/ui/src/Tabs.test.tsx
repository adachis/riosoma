import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { faDatabase, faKey, faTable } from '@fortawesome/free-solid-svg-icons';
import { describe, expect, it } from 'vitest';
import { Tab, TabList, TabPanel, Tabs } from './Tabs';

function DatabaseTabs({
  orientation = 'horizontal',
  keyboardActivation,
}: {
  orientation?: 'horizontal' | 'vertical';
  keyboardActivation?: 'automatic' | 'manual';
}) {
  return (
    <Tabs orientation={orientation} keyboardActivation={keyboardActivation} defaultSelectedKey="tables">
      <TabList aria-label="Database sections">
        <Tab id="tables" icon={faTable}>
          Tables
        </Tab>
        <Tab id="keys" icon={faKey}>
          Keys
        </Tab>
        <Tab id="settings" isDisabled icon={faDatabase}>
          Settings
        </Tab>
      </TabList>
      <TabPanel id="tables">Every table in this database</TabPanel>
      <TabPanel id="keys">Every key in this database</TabPanel>
      <TabPanel id="settings">Every setting</TabPanel>
    </Tabs>
  );
}

/** The bar that marks the selected tab; there is exactly one, inside the selected tab. */
function indicators(tab: HTMLElement) {
  return tab.querySelectorAll('.rio-tab__indicator');
}

describe('Tabs', () => {
  it('names each tab and mounts only the selected panel', () => {
    render(<DatabaseTabs />);
    const tablist = screen.getByRole('tablist', { name: 'Database sections' });
    expect(
      within(tablist)
        .getAllByRole('tab')
        .map((tab) => tab.textContent),
    ).toEqual(['Tables', 'Keys', 'Settings']);
    expect(screen.getByRole('tab', { name: 'Tables' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getAllByRole('tabpanel')).toHaveLength(1);
    expect(screen.getByRole('tabpanel').textContent).toBe('Every table in this database');
  });

  it('keeps the icon decorative next to the label', () => {
    render(<DatabaseTabs />);
    const icon = screen.getByRole('tab', { name: 'Tables' }).querySelector('svg');
    expect(icon?.getAttribute('aria-hidden')).toBe('true');
  });

  it('keeps one indicator, on the selected tab', async () => {
    render(<DatabaseTabs />);
    const tables = screen.getByRole('tab', { name: 'Tables' });
    const keys = screen.getByRole('tab', { name: 'Keys' });
    expect(indicators(tables)).toHaveLength(1);
    expect(indicators(keys)).toHaveLength(0);
    await userEvent.click(keys);
    expect(keys.getAttribute('aria-selected')).toBe('true');
    expect(indicators(keys)).toHaveLength(1);
    expect(indicators(tables)).toHaveLength(0);
  });

  it('moves the selection and the focus with the arrow keys', async () => {
    render(<DatabaseTabs />);
    const tables = screen.getByRole('tab', { name: 'Tables' });
    const keys = screen.getByRole('tab', { name: 'Keys' });
    tables.focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(keys);
    expect(keys.getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tabpanel').textContent).toBe('Every key in this database');
    await userEvent.keyboard('{ArrowLeft}');
    expect(document.activeElement).toBe(tables);
    expect(tables.getAttribute('aria-selected')).toBe('true');
  });

  it('jumps to the first and last enabled tab with Home and End', async () => {
    render(<DatabaseTabs />);
    const tables = screen.getByRole('tab', { name: 'Tables' });
    tables.focus();
    await userEvent.keyboard('{End}');
    // Settings is disabled, so End stops on the last tab a user can reach.
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Keys' }));
    await userEvent.keyboard('{Home}');
    expect(document.activeElement).toBe(tables);
  });

  it('skips a disabled tab and reports it as unavailable', async () => {
    render(<DatabaseTabs />);
    const settings = screen.getByRole('tab', { name: 'Settings' });
    expect(settings.getAttribute('aria-disabled')).toBe('true');
    expect(settings.hasAttribute('data-disabled')).toBe(true);
    screen.getByRole('tab', { name: 'Keys' }).focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Tables' }));
  });

  it('separates focus from selection with manual activation', async () => {
    render(<DatabaseTabs keyboardActivation="manual" />);
    const tables = screen.getByRole('tab', { name: 'Tables' });
    const keys = screen.getByRole('tab', { name: 'Keys' });
    tables.focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(keys);
    expect(keys.getAttribute('aria-selected')).toBe('false');
    expect(screen.getByRole('tabpanel').textContent).toBe('Every table in this database');
    await userEvent.keyboard('{Enter}');
    expect(keys.getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tabpanel').textContent).toBe('Every key in this database');
  });

  it('lays a vertical tab list out with the up and down arrows', async () => {
    render(<DatabaseTabs orientation="vertical" />);
    const tablist = screen.getByRole('tablist', { name: 'Database sections' });
    expect(tablist.getAttribute('data-orientation')).toBe('vertical');
    const tables = screen.getByRole('tab', { name: 'Tables' });
    const keys = screen.getByRole('tab', { name: 'Keys' });
    tables.focus();
    await userEvent.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(keys);
    expect(keys.getAttribute('aria-selected')).toBe('true');
    await userEvent.keyboard('{ArrowUp}');
    expect(document.activeElement).toBe(tables);
  });
});
