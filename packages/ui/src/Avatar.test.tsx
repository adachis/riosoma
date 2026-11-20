import { i18n } from '@lingui/core';
import { act, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Avatar, avatarInitials, PersonDirectory } from './Avatar';
import { gallery } from './Avatar.gallery';
import { render } from './test/render';

/** The avatar of one person, found the way assistive technology finds it. */
function avatar(name: string): HTMLElement {
  return screen.getByRole('img', { name });
}

describe('Avatar', () => {
  it('uses the current picture and status and falls back when the picture cannot load', () => {
    render(
      <PersonDirectory.Provider
        value={
          new Map([
            [
              'person',
              { name: 'Current person', pictureUrl: '/api/people/person/picture?v=1', deactivated: true },
            ],
          ])
        }
      >
        <Avatar personId="person" name="Old name" color="blue" />
      </PersonDirectory.Provider>,
    );
    const current = avatar('Current person (deactivated)');
    expect(current.dataset.deactivated).toBe('true');
    const picture = current.querySelector('img')!;
    expect(picture.getAttribute('src')).toBe('/api/people/person/picture?v=1');
    fireEvent.error(picture);
    expect(current.textContent).toBe('CP');
  });

  it('removes a current picture without falling back to stale picture props', () => {
    render(
      <PersonDirectory.Provider value={new Map([['person', { name: 'Current person', pictureUrl: null }]])}>
        <Avatar
          personId="person"
          name="Old name"
          pictureUrl="/api/people/person/picture?v=old"
          color="blue"
        />
      </PersonDirectory.Provider>,
    );
    expect(avatar('CP: Current person').querySelector('img')).toBeNull();
    expect(avatar('CP: Current person').textContent).toBe('CP');
  });

  afterEach(() => {
    act(() => {
      i18n.activate('en-US');
    });
  });

  it('is one image named by the person, painted in their color', () => {
    render(<Avatar name="Ada Lovelace" color="blue" />);

    // The name includes the visible initials and identifies the person.
    expect(avatar('AL: Ada Lovelace').textContent).toBe('AL');
    expect(avatar('AL: Ada Lovelace').dataset.color).toBe('blue');
    expect(avatar('AL: Ada Lovelace').dataset.size).toBe('md');
    expect(screen.getAllByRole('img')).toHaveLength(1);
  });

  it('takes the dense size for a grid cell', () => {
    render(<Avatar size="sm" name="Ada Lovelace" color="blue" />);
    expect(avatar('AL: Ada Lovelace').dataset.size).toBe('sm');
  });

  it.each([
    ['Ada Lovelace', 'AL'],
    ['Plato', 'P'],
    ['山田 太郎', '山太'],
    // Only the first two words count, and the locale decides what a word is and how it reads in
    // upper case.
    ['Grace Brewster Murray Hopper', 'GB'],
    ['ada lovelace', 'AL'],
    ['Ada', 'A'],
  ])('reads the initials of %s as %s', (name, initials) => {
    render(<Avatar name={name} color="teal" />);
    expect(avatar(`${initials}: ${name}`).textContent).toBe(initials);
  });

  it('uppercases the initials by the rules of the active locale', () => {
    act(() => {
      i18n.load('tr', {});
      i18n.activate('tr');
    });
    // A dotless i in Turkish, which an English rule would turn into a plain I.
    render(<Avatar name="izmir" color="teal" />);
    expect(avatar('İ: izmir').textContent).toBe('İ');
  });

  it('renders every gallery example', () => {
    for (const example of gallery.examples) {
      const { unmount } = render(<>{example.render()}</>);
      unmount();
    }
    expect(gallery.examples.length).toBeGreaterThan(0);
  });
});

it('shares the visible initials with controls that include an avatar in their name', () => {
  render(<Avatar name="Ada Lovelace" color="blue" />);
  expect(avatar('AL: Ada Lovelace').textContent).toBe(avatarInitials('Ada Lovelace', i18n.locale));
});

it('includes visible initials before the full name', () => {
  render(<Avatar name="Ada Lovelace" color="blue" />);
  expect(avatar('AL: Ada Lovelace').textContent).toBe('AL');
});
