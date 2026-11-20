import { render, screen } from '@testing-library/react';
import { Input, TextField } from 'react-aria-components';
import { describe, expect, it } from 'vitest';
import { Label } from './Field';
import { Text } from './Text';

describe('Text', () => {
  it('renders running text in a span', () => {
    render(<Text>Two replicas follow the primary.</Text>);
    const text = screen.getByText('Two replicas follow the primary.');
    expect(text.tagName).toBe('SPAN');
    expect(text.className).toBe('rio-text');
    expect(text.getAttribute('data-variant')).toBe('body');
  });

  it('names each variant on the element, so a theme can style it', () => {
    render(
      <>
        <Text variant="body">Body</Text>
        <Text variant="muted">Muted</Text>
        <Text variant="small">Small</Text>
        <Text variant="mono">mono</Text>
      </>,
    );
    expect(screen.getByText('Body').getAttribute('data-variant')).toBe('body');
    expect(screen.getByText('Muted').getAttribute('data-variant')).toBe('muted');
    expect(screen.getByText('Small').getAttribute('data-variant')).toBe('small');
    const mono = screen.getByText('mono');
    expect(mono.getAttribute('data-variant')).toBe('mono');
    expect(mono.className.split(' ')).toContain('rio-text');
  });

  it('renders the element a caller asks for', () => {
    render(
      <Text elementType="p" className="intro">
        Riosoma is a self-hosted database platform.
      </Text>,
    );
    expect(screen.getByText('Riosoma is a self-hosted database platform.').tagName).toBe('P');
    expect(screen.getByText('Riosoma is a self-hosted database platform.').className).toBe('rio-text intro');
  });

  it('describes a field when it is given the description slot', () => {
    render(
      <TextField>
        <Label>Database name</Label>
        <Input />
        <Text slot="description" variant="small">
          Lowercase letters, digits, and dashes.
        </Text>
      </TextField>,
    );
    const input = screen.getByRole('textbox', { name: 'Database name' });
    const describedBy = input.getAttribute('aria-describedby');
    expect(describedBy).not.toBeNull();
    expect(document.getElementById(describedBy!)?.textContent).toBe('Lowercase letters, digits, and dashes.');
  });
});
