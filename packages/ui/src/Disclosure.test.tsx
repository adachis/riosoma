import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { faSliders } from '@fortawesome/free-solid-svg-icons';
import { describe, expect, it, vi } from 'vitest';
import { Disclosure, DisclosureGroup, DisclosurePanel, DisclosureTrigger } from './Disclosure';

function AdvancedSettings({
  onExpandedChange,
  isDisabled,
}: {
  onExpandedChange?: (isExpanded: boolean) => void;
  isDisabled?: boolean;
} = {}) {
  return (
    <Disclosure onExpandedChange={onExpandedChange} isDisabled={isDisabled}>
      <DisclosureTrigger icon={faSliders}>Advanced</DisclosureTrigger>
      <DisclosurePanel>Compaction runs every six hours.</DisclosurePanel>
    </Disclosure>
  );
}

function rootOf(trigger: HTMLElement) {
  return trigger.closest('.rio-disclosure');
}

describe('Disclosure', () => {
  it('starts closed, with its content out of reach', () => {
    render(<AdvancedSettings />);
    const trigger = screen.getByRole('button', { name: 'Advanced' });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    // The panel is hidden, so it is not in the accessibility tree at all.
    expect(screen.queryByRole('group')).toBeNull();
    expect(rootOf(trigger)?.hasAttribute('data-expanded')).toBe(false);
  });

  it('puts the trigger in a heading, so the section is in the outline', () => {
    render(<AdvancedSettings />);
    const heading = screen.getByRole('heading', { level: 3 });
    expect(heading.textContent).toBe('Advanced');
    expect(heading.querySelector('button')).toBe(screen.getByRole('button', { name: 'Advanced' }));
  });

  it('opens on a press and names its panel after the trigger', async () => {
    const onExpandedChange = vi.fn();
    render(<AdvancedSettings onExpandedChange={onExpandedChange} />);
    const trigger = screen.getByRole('button', { name: 'Advanced' });
    await userEvent.click(trigger);
    expect(onExpandedChange).toHaveBeenCalledWith(true);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(rootOf(trigger)?.hasAttribute('data-expanded')).toBe(true);
    const panel = screen.getByRole('group', { name: 'Advanced' });
    expect(panel.textContent).toBe('Compaction runs every six hours.');
    expect(panel.id).toBe(trigger.getAttribute('aria-controls'));
    // The chevron turns with the state instead of being swapped, so the header keeps its size.
    expect(trigger.querySelector('svg.rio-disclosure__chevron')).not.toBeNull();
  });

  it('opens and closes from the keyboard', async () => {
    render(<AdvancedSettings />);
    const trigger = screen.getByRole('button', { name: 'Advanced' });
    trigger.focus();
    await userEvent.keyboard('{Enter}');
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('group', { name: 'Advanced' })).toBeDefined();
    await userEvent.keyboard(' ');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('group')).toBeNull();
  });

  it('starts open when the caller says so', () => {
    render(
      <Disclosure defaultExpanded>
        <DisclosureTrigger>Advanced</DisclosureTrigger>
        <DisclosurePanel>Compaction runs every six hours.</DisclosurePanel>
      </Disclosure>,
    );
    expect(screen.getByRole('button', { name: 'Advanced' }).getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('group', { name: 'Advanced' })).toBeDefined();
  });

  it('stays closed when it is disabled', async () => {
    const onExpandedChange = vi.fn();
    render(<AdvancedSettings isDisabled onExpandedChange={onExpandedChange} />);
    const trigger = screen.getByRole('button', { name: 'Advanced' });
    expect(trigger.hasAttribute('disabled')).toBe(true);
    expect(rootOf(trigger)?.hasAttribute('data-disabled')).toBe(true);
    await userEvent.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(onExpandedChange).not.toHaveBeenCalled();
    expect(screen.queryByRole('group')).toBeNull();
  });
});

describe('DisclosureGroup', () => {
  function SettingsAccordion({ allowsMultipleExpanded }: { allowsMultipleExpanded?: boolean } = {}) {
    return (
      <DisclosureGroup allowsMultipleExpanded={allowsMultipleExpanded} defaultExpandedKeys={['storage']}>
        <Disclosure id="storage">
          <DisclosureTrigger>Storage</DisclosureTrigger>
          <DisclosurePanel>120 GiB used of 500 GiB.</DisclosurePanel>
        </Disclosure>
        <Disclosure id="replication">
          <DisclosureTrigger>Replication</DisclosureTrigger>
          <DisclosurePanel>Two replicas follow the primary.</DisclosurePanel>
        </Disclosure>
      </DisclosureGroup>
    );
  }

  it('closes one section when another opens', async () => {
    render(<SettingsAccordion />);
    const storage = screen.getByRole('button', { name: 'Storage' });
    const replication = screen.getByRole('button', { name: 'Replication' });
    expect(storage.getAttribute('aria-expanded')).toBe('true');
    expect(replication.getAttribute('aria-expanded')).toBe('false');
    await userEvent.click(replication);
    expect(replication.getAttribute('aria-expanded')).toBe('true');
    expect(storage.getAttribute('aria-expanded')).toBe('false');
    expect(screen.getAllByRole('group')).toHaveLength(1);
    expect(screen.getByRole('group', { name: 'Replication' }).textContent).toBe(
      'Two replicas follow the primary.',
    );
  });

  it('keeps every section open when it is allowed to', async () => {
    render(<SettingsAccordion allowsMultipleExpanded />);
    const storage = screen.getByRole('button', { name: 'Storage' });
    await userEvent.click(screen.getByRole('button', { name: 'Replication' }));
    expect(storage.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getAllByRole('group')).toHaveLength(2);
  });

  it('disables every section in it at once', async () => {
    render(
      <DisclosureGroup isDisabled>
        <Disclosure id="storage">
          <DisclosureTrigger>Storage</DisclosureTrigger>
          <DisclosurePanel>120 GiB used of 500 GiB.</DisclosurePanel>
        </Disclosure>
      </DisclosureGroup>,
    );
    const trigger = screen.getByRole('button', { name: 'Storage' });
    expect(trigger.hasAttribute('disabled')).toBe(true);
    await userEvent.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });

  it('keeps the styles a caller adds', () => {
    render(
      <DisclosureGroup className="settings">
        <Disclosure id="storage" className="settings__storage">
          <DisclosureTrigger>Storage</DisclosureTrigger>
          <DisclosurePanel>120 GiB used of 500 GiB.</DisclosurePanel>
        </Disclosure>
      </DisclosureGroup>,
    );
    const group = screen.getByRole('button', { name: 'Storage' }).closest('.rio-disclosure-group');
    expect(group?.className.split(' ')).toEqual(['rio-disclosure-group', 'settings']);
    expect(rootOf(screen.getByRole('button', { name: 'Storage' }))?.className.split(' ')).toEqual([
      'rio-disclosure',
      'settings__storage',
    ]);
  });
});
