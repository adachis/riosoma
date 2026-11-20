import { ChoicePill } from './ChoicePill';
import type { GalleryEntry } from './gallery';

// Gallery examples are a developer tool, so their sample labels are plain text.
export const gallery: GalleryEntry = {
  id: 'ui.choice-pill',
  title: 'ChoicePill',
  examples: [
    {
      id: 'colors',
      render: () => (
        <>
          <ChoicePill name="Backlog" color="gray" />
          <ChoicePill name="Blocked" color="red" />
          <ChoicePill name="In review" color="orange" />
          <ChoicePill name="Triaged" color="yellow" />
          <ChoicePill name="Ready" color="green" />
          <ChoicePill name="In progress" color="teal" />
          <ChoicePill name="Deployed" color="blue" />
          <ChoicePill name="Scheduled" color="purple" />
          <ChoicePill name="Needs design" color="pink" />
          <ChoicePill name="Archived" color="brown" />
        </>
      ),
    },
    {
      id: 'sizes',
      render: () => (
        <>
          <ChoicePill size="sm" name="Deployed" color="blue" />
          <ChoicePill name="Deployed" color="blue" />
        </>
      ),
    },
    {
      id: 'removable',
      render: () => (
        <>
          <ChoicePill size="sm" name="Deployed" color="blue" onRemove={() => {}} />
          <ChoicePill name="Needs design" color="pink" onRemove={() => {}} />
        </>
      ),
    },
    {
      id: 'clipped',
      render: () => (
        <>
          {/* The narrow box is the example's, standing in for a grid cell: the name is longer than
              the room it has, so the pill clips and the tooltip carries the rest. */}
          <span style={{ display: 'inline-block', inlineSize: '130px' }}>
            <ChoicePill size="sm" name="Deployed to production" color="green" />
          </span>
          <span style={{ display: 'inline-block', inlineSize: '130px' }}>
            <ChoicePill name="Deployed to production" color="green" onRemove={() => {}} />
          </span>
          <span style={{ display: 'inline-block', inlineSize: '130px' }}>
            <ChoicePill name="Fits" color="green" />
          </span>
        </>
      ),
    },
  ],
};
