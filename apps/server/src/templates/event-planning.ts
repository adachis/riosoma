import { choices, grid, type StarterTemplate } from './types.js';

const events = [
  'Community breakfast',
  'Spring workshop',
  'Partner meetup',
  'Product showcase',
  'Volunteer orientation',
  'Summer open house',
  'Design roundtable',
  'Neighborhood picnic',
  'Fundraising dinner',
  'Fall conference',
  'Customer forum',
  'Skills exchange',
  'Winter market',
  'Annual celebration',
  'Planning retreat',
];
export const eventPlanning: StarterTemplate = {
  id: 'event-planning',
  name: 'Event planning',
  description: 'Coordinate event schedules, guest responses, and vendor budgets in one place.',
  icon: 'champagne-glasses',
  color: 'pink',
  category: 'organizations',
  tables: [
    {
      key: 'events',
      name: 'Events',
      fields: [
        { key: 'name', name: 'Event', type: 'text' },
        { key: 'start', name: 'Start', type: 'date', options: { includeTime: true, timeZone: 'UTC' } },
        { key: 'end', name: 'End', type: 'date', options: { includeTime: true, timeZone: 'UTC' } },
        { key: 'venue', name: 'Venue', type: 'text' },
        { key: 'budget', name: 'Budget', type: 'currency' },
        {
          key: 'guests',
          name: 'Guests',
          type: 'link',
          inverse: true,
          options: { linkedTableKey: 'guests', inverseFieldKey: 'event' },
        },
        {
          key: 'vendors',
          name: 'Vendors',
          type: 'link',
          inverse: true,
          options: { linkedTableKey: 'vendors', inverseFieldKey: 'event' },
        },
        {
          key: 'cost',
          name: 'Vendor costs',
          type: 'rollup',
          options: { linkFieldKey: 'vendors', targetFieldKey: 'cost', fn: 'sum' },
        },
        {
          key: 'remaining',
          name: 'Budget remaining',
          type: 'formula',
          options: { expression: '{Budget} - {Vendor costs}', precision: 2 },
        },
      ],
      views: [
        grid,
        { key: 'calendar', name: 'Event calendar', type: 'calendar', startField: 'start', endField: 'end' },
      ],
      records: events.map((name, i) => ({
        key: `event-${i}`,
        values: {
          name,
          start: { days: i * 4 - 4, time: '17:00' },
          end: { days: i * 4 - 4, time: '20:00' },
          venue: ['Community hall', 'Garden pavilion', 'Downtown studio'][i % 3]!,
          budget: 2000 + i * 200,
        },
      })),
    },
    {
      key: 'guests',
      name: 'Guests',
      fields: [
        { key: 'name', name: 'Guest name', type: 'text' },
        { key: 'email', name: 'Email', type: 'email' },
        {
          key: 'event',
          name: 'Event',
          type: 'link',
          options: { linkedTableKey: 'events', inverseFieldKey: 'guests', prefersSingle: true },
        },
        {
          key: 'rsvp',
          name: 'RSVP',
          type: 'singleSelect',
          options: choices('Awaiting reply', 'Attending', 'Declined'),
        },
        { key: 'diet', name: 'Dietary notes', type: 'longText' },
      ],
      views: [
        grid,
        {
          key: 'rsvp',
          name: 'Guest RSVP',
          type: 'form',
          form: {
            title: 'Event RSVP',
            description: 'Let us know whether you can join us.',
            submitLabel: 'Send RSVP',
            thankYou: 'Thank you for your response.',
          },
          questions: [
            { field: 'name', required: true },
            { field: 'email', required: true },
            { field: 'event', required: true },
            { field: 'rsvp', required: true },
            { field: 'diet' },
          ],
        },
      ],
      records: Array.from({ length: 30 }, (_, i) => ({
        key: `guest-${i}`,
        values: {
          name: `Community group ${i + 1}`,
          email: `group-${i + 1}@guests.example.com`,
          event: [`event-${i % 15}`],
          rsvp: ['Awaiting reply', 'Attending', 'Declined'][i % 3]!,
          diet: i % 4 === 0 ? 'Vegetarian meal requested.' : '',
        },
      })),
    },
    {
      key: 'vendors',
      name: 'Vendors',
      fields: [
        { key: 'name', name: 'Vendor', type: 'text' },
        {
          key: 'event',
          name: 'Event',
          type: 'link',
          options: { linkedTableKey: 'events', inverseFieldKey: 'vendors', prefersSingle: true },
        },
        {
          key: 'service',
          name: 'Service',
          type: 'singleSelect',
          options: choices('Catering', 'Equipment', 'Flowers'),
        },
        { key: 'cost', name: 'Cost', type: 'currency' },
        { key: 'confirmed', name: 'Confirmed', type: 'checkbox' },
      ],
      views: [grid],
      records: Array.from({ length: 30 }, (_, i) => ({
        key: `vendor-${i}`,
        values: {
          name: `${['Garden Catering', 'Bright Sound', 'Meadow Flowers'][i % 3]} booking ${i + 1}`,
          event: [`event-${i % 15}`],
          service: ['Catering', 'Equipment', 'Flowers'][i % 3]!,
          cost: 250 + i * 25,
          confirmed: i % 3 !== 0,
        },
      })),
    },
  ],
};
