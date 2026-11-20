import { choices, grid, type StarterTemplate } from './types.js';

const channels = [
  'Company blog',
  'Weekly newsletter',
  'Product updates',
  'Community digest',
  'Customer stories',
  'Video tutorials',
  'Webinars',
  'Help center',
  'Partner newsletter',
  'Press room',
  'Podcast',
  'Developer journal',
  'Events bulletin',
  'Research notes',
  'Social updates',
];
const topics = ['Getting started', 'A closer look', 'Practical tips', 'Behind the scenes', 'What comes next'];
export const contentCalendar: StarterTemplate = {
  id: 'content-calendar',
  name: 'Content calendar',
  description: 'Plan a steady publishing schedule across channels, from first draft to launch.',
  icon: 'calendar-days',
  color: 'purple',
  category: 'work',
  tables: [
    {
      key: 'channels',
      name: 'Channels',
      fields: [
        { key: 'name', name: 'Channel', type: 'text' },
        {
          key: 'cadence',
          name: 'Cadence',
          type: 'singleSelect',
          options: choices('Weekly', 'Monthly', 'As needed'),
        },
        { key: 'url', name: 'Home page', type: 'url' },
        {
          key: 'posts',
          name: 'Posts',
          type: 'link',
          inverse: true,
          options: { linkedTableKey: 'posts', inverseFieldKey: 'channel' },
        },
      ],
      views: [grid],
      records: channels.map((name, i) => ({
        key: `channel-${i}`,
        values: {
          name,
          cadence: ['Weekly', 'Monthly', 'As needed'][i % 3]!,
          url: `https://publication.example.com/channel-${i + 1}`,
        },
      })),
    },
    {
      key: 'posts',
      name: 'Posts',
      fields: [
        { key: 'name', name: 'Title', type: 'text' },
        { key: 'brief', name: 'Brief', type: 'longText' },
        {
          key: 'channel',
          name: 'Channel',
          type: 'link',
          options: { linkedTableKey: 'channels', inverseFieldKey: 'posts', prefersSingle: true },
        },
        {
          key: 'status',
          name: 'Status',
          type: 'singleSelect',
          options: choices('Idea', 'Draft', 'Published', 'Scheduled'),
        },
        {
          key: 'publish',
          name: 'Publish date',
          type: 'date',
          options: { includeTime: true, timeZone: 'UTC' },
        },
        { key: 'words', name: 'Word count', type: 'number' },
        {
          key: 'minutes',
          name: 'Reading minutes',
          type: 'formula',
          options: { expression: 'ROUNDUP({Word count} / 200, 0)' },
        },
        {
          key: 'cadence',
          name: 'Channel cadence',
          type: 'lookup',
          options: { linkFieldKey: 'channel', targetFieldKey: 'cadence' },
        },
        {
          key: 'topics',
          name: 'Topics',
          type: 'multipleSelect',
          options: choices('Education', 'Product', 'Community'),
        },
      ],
      views: [
        grid,
        { key: 'calendar', name: 'Publishing schedule', type: 'calendar', startField: 'publish' },
        { key: 'status', name: 'Editorial board', type: 'kanban', stackField: 'status' },
        { key: 'gallery', name: 'Story gallery', type: 'gallery' },
      ],
      records: Array.from({ length: 30 }, (_, i) => ({
        key: `post-${i}`,
        values: {
          name: `${topics[i % 5]}: ${channels[i % 15]}`,
          brief: `Share useful examples and one clear next step for readers of ${channels[i % 15]}.`,
          channel: [`channel-${i % 15}`],
          status: ['Idea', 'Draft', 'Published', 'Scheduled'][i % 4]!,
          publish: { days: i - 10, time: '14:00' },
          words: 400 + i * 50,
          topics: [i % 2 ? 'Education' : 'Product', 'Community'],
        },
      })),
    },
  ],
};
