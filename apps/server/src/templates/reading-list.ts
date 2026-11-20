import { choices, grid, type StarterTemplate } from './types.js';

const authors = [
  'A. Brook',
  'B. Cedar',
  'C. Vale',
  'D. Reed',
  'E. North',
  'F. Lake',
  'G. Rowan',
  'H. Field',
  'J. Stone',
  'K. Moss',
  'L. Finch',
  'M. River',
  'N. Ash',
  'P. Wren',
  'R. Grove',
];
const books = [
  'The Quiet Harbor',
  'Small Daily Wonders',
  'Beyond the Orchard',
  'A Map of Home',
  'The Long Afternoon',
  'Making Room',
  'Letters from the Valley',
  'The Garden Notebook',
  'Paths Through Winter',
  'A Practical Curiosity',
  'The Last Lantern',
  'Notes on Listening',
  'The Open Window',
  'An Ordinary Adventure',
  'The Art of Starting',
];
export const readingList: StarterTemplate = {
  id: 'reading-list',
  name: 'Reading list',
  description: 'Collect your next reads, track your progress, and remember favorite books and authors.',
  icon: 'book-open',
  color: 'teal',
  category: 'personal',
  tables: [
    {
      key: 'books',
      name: 'Books',
      fields: [
        { key: 'name', name: 'Title', type: 'text' },
        {
          key: 'author',
          name: 'Author',
          type: 'link',
          options: { linkedTableKey: 'authors', inverseFieldKey: 'books' },
        },
        {
          key: 'status',
          name: 'Reading status',
          type: 'singleSelect',
          options: choices('Want to read', 'Reading', 'Finished'),
        },
        { key: 'rating', name: 'Rating', type: 'rating' },
        { key: 'pages', name: 'Pages', type: 'number' },
        { key: 'read', name: 'Pages read', type: 'number' },
        {
          key: 'progress',
          name: 'Progress',
          type: 'formula',
          options: { expression: 'IF({Pages} > 0, {Pages read} / {Pages}, 0)', precision: 2 },
        },
        { key: 'finished', name: 'Finished on', type: 'date' },
        { key: 'notes', name: 'Reading notes', type: 'longText' },
        {
          key: 'genre',
          name: 'Genre',
          type: 'lookup',
          options: { linkFieldKey: 'author', targetFieldKey: 'genre' },
        },
      ],
      views: [
        grid,
        { key: 'status', name: 'Reading board', type: 'kanban', stackField: 'status' },
        { key: 'gallery', name: 'Bookshelf', type: 'gallery' },
      ],
      records: books.map((name, i) => ({
        key: `book-${i}`,
        values: {
          name,
          author: [`author-${i}`],
          status: ['Want to read', 'Reading', 'Finished'][i % 3]!,
          rating: i % 3 === 2 ? 3 + (i % 3) : null,
          pages: 180 + i * 12,
          read: i % 3 === 2 ? 180 + i * 12 : i % 3 === 1 ? 60 : 0,
          finished: i % 3 === 2 ? { days: -i } : null,
          notes:
            i % 3 === 2
              ? 'A thoughtful read to revisit and discuss.'
              : 'Sample title for planning your reading.',
        },
      })),
    },
    {
      key: 'authors',
      name: 'Authors',
      fields: [
        { key: 'name', name: 'Pen name', type: 'text' },
        {
          key: 'genre',
          name: 'Genre',
          type: 'singleSelect',
          options: choices('Fiction', 'Essays', 'Practical guides'),
        },
        { key: 'notes', name: 'Notes', type: 'longText' },
        {
          key: 'books',
          name: 'Books',
          type: 'link',
          inverse: true,
          options: { linkedTableKey: 'books', inverseFieldKey: 'author' },
        },
      ],
      views: [grid],
      records: authors.map((name, i) => ({
        key: `author-${i}`,
        values: {
          name,
          genre: ['Fiction', 'Essays', 'Practical guides'][i % 3]!,
          notes: 'Fictional author included to demonstrate a linked reading list.',
        },
      })),
    },
  ],
};
