import { faDatabase, faKey, faStar, faTable } from '@fortawesome/free-solid-svg-icons';
import { ListBox, ListBoxItem, ListBoxSection } from './ListBox';
import type { GalleryEntry } from './gallery';

// Gallery examples are a developer tool, so their sample labels are plain text.
export const gallery: GalleryEntry = {
  id: 'ui.listBox',
  title: 'ListBox',
  examples: [
    {
      id: 'single',
      render: () => (
        <ListBox aria-label="Connection" selectionMode="single" defaultSelectedKeys={['staging']}>
          <ListBoxItem id="local">local</ListBoxItem>
          <ListBoxItem id="staging">staging</ListBoxItem>
          <ListBoxItem id="production">production</ListBoxItem>
        </ListBox>
      ),
    },
    {
      id: 'multiple',
      render: () => (
        <ListBox
          aria-label="Visible columns"
          selectionMode="multiple"
          defaultSelectedKeys={['name', 'created']}
        >
          <ListBoxItem id="name">name</ListBoxItem>
          <ListBoxItem id="email">email</ListBoxItem>
          <ListBoxItem id="created">created_at</ListBoxItem>
        </ListBox>
      ),
    },
    {
      id: 'sections',
      render: () => (
        <ListBox aria-label="Tables" selectionMode="single">
          <ListBoxSection title="Public">
            <ListBoxItem id="people" icon={faTable}>
              people
            </ListBoxItem>
            <ListBoxItem id="orders" icon={faTable}>
              orders
            </ListBoxItem>
          </ListBoxSection>
          <ListBoxSection title="Internal">
            <ListBoxItem id="sessions" icon={faDatabase}>
              sessions
            </ListBoxItem>
            <ListBoxItem id="audit" icon={faKey}>
              audit_log
            </ListBoxItem>
          </ListBoxSection>
        </ListBox>
      ),
    },
    {
      id: 'details',
      render: () => (
        <ListBox aria-label="Favorites" selectionMode="single" defaultSelectedKeys={['people']}>
          <ListBoxItem id="people" icon={faStar} description="1.2 million rows">
            people
          </ListBoxItem>
          <ListBoxItem id="orders" icon={faStar} description="Empty since the last import">
            orders
          </ListBoxItem>
        </ListBox>
      ),
    },
    {
      id: 'states',
      render: () => (
        <ListBox aria-label="Schemas" selectionMode="single">
          <ListBoxItem id="public">public</ListBoxItem>
          <ListBoxItem id="archive" isDisabled>
            archive (read only)
          </ListBoxItem>
        </ListBox>
      ),
    },
    {
      id: 'sizes',
      render: () => (
        <>
          <ListBox aria-label="Dense" size="sm" selectionMode="single">
            <ListBoxItem id="one">query_one</ListBoxItem>
            <ListBoxItem id="two">query_two</ListBoxItem>
          </ListBox>
          <ListBox aria-label="Roomy" size="lg" selectionMode="single">
            <ListBoxItem id="one">query_one</ListBoxItem>
            <ListBoxItem id="two">query_two</ListBoxItem>
          </ListBox>
        </>
      ),
    },
    {
      id: 'plain',
      render: () => (
        <ListBox aria-label="Recent queries">
          <ListBoxItem id="recent-1">select * from people limit 10</ListBoxItem>
          <ListBoxItem id="recent-2">select count(*) from orders</ListBoxItem>
        </ListBox>
      ),
    },
  ],
};
