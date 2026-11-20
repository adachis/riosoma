import type { ChoiceColor } from '@riosoma/contracts';
import { Avatar } from './Avatar';
import type { GalleryEntry } from './gallery';

// Gallery examples are a developer tool, so their sample names are plain text.
const PEOPLE: Array<{ name: string; color: ChoiceColor }> = [
  { name: 'Ada Lovelace', color: 'gray' },
  { name: 'Grace Hopper', color: 'red' },
  { name: 'Alan Turing', color: 'orange' },
  { name: 'Katherine Johnson', color: 'yellow' },
  { name: 'Edsger Dijkstra', color: 'green' },
  { name: 'Barbara Liskov', color: 'teal' },
  { name: 'Donald Knuth', color: 'blue' },
  { name: 'Radia Perlman', color: 'purple' },
  { name: 'Margaret Hamilton', color: 'pink' },
  { name: '山田 太郎', color: 'brown' },
];

export const gallery: GalleryEntry = {
  id: 'ui.avatar',
  title: 'Avatar',
  examples: [
    {
      id: 'sizes',
      render: () => (
        <>
          <Avatar size="sm" name="Ada Lovelace" color="blue" />
          <Avatar name="Ada Lovelace" color="blue" />
        </>
      ),
    },
    {
      id: 'colors',
      render: () => (
        <>
          {PEOPLE.map((person) => (
            <Avatar key={person.color} name={person.name} color={person.color} />
          ))}
        </>
      ),
    },
    {
      id: 'initials',
      render: () => (
        <>
          {/* One word, two words, three words, a name the locale writes without spaces, and a name
              in lower case: the first two letters of the first two words, in the locale's rules. */}
          <Avatar name="Plato" color="teal" />
          <Avatar name="Ada Lovelace" color="teal" />
          <Avatar name="Grace Brewster Murray Hopper" color="teal" />
          <Avatar name="山田太郎" color="teal" />
          <Avatar name="ada lovelace" color="teal" />
        </>
      ),
    },
    {
      id: 'in-context',
      render: () => (
        <>
          {PEOPLE.slice(0, 4).map((person) => (
            <span
              key={person.name}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--rio-space-2)' }}
            >
              <Avatar size="sm" name={person.name} color={person.color} />
              {person.name}
            </span>
          ))}
        </>
      ),
    },
  ],
};
