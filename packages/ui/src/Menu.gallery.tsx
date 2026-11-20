import {
  faArrowRightFromBracket,
  faCopy,
  faDownload,
  faEllipsis,
  faPencil,
  faTrashCan,
} from '@fortawesome/free-solid-svg-icons';
import { Button } from './Button';
import { Menu, MenuItem, MenuSection, MenuSeparator, MenuTrigger, SubmenuTrigger } from './Menu';
import type { GalleryEntry } from './gallery';

// Gallery examples are a developer tool, so their sample labels are plain text.
export const gallery: GalleryEntry = {
  id: 'ui.menu',
  title: 'Menu',
  examples: [
    {
      id: 'actions',
      render: () => (
        <MenuTrigger>
          <Button>Actions</Button>
          <Menu aria-label="Actions">
            <MenuItem id="rename" icon={faPencil} shortcut="⌘R">
              Rename
            </MenuItem>
            <MenuItem id="duplicate" icon={faCopy} shortcut="⌘D">
              Duplicate
            </MenuItem>
            <MenuSeparator />
            <MenuItem id="delete" icon={faTrashCan} tone="danger" shortcut="⌫">
              Delete
            </MenuItem>
          </Menu>
        </MenuTrigger>
      ),
    },
    {
      id: 'icon-only-trigger',
      render: () => (
        <MenuTrigger>
          <Button variant="quiet" icon={faEllipsis} aria-label="Row actions" />
          <Menu aria-label="Row actions">
            <MenuItem id="open">Open</MenuItem>
            <MenuItem id="copy">Copy row</MenuItem>
            <MenuItem id="delete" tone="danger">
              Delete row
            </MenuItem>
          </Menu>
        </MenuTrigger>
      ),
    },
    {
      id: 'sections',
      render: () => (
        <MenuTrigger>
          <Button variant="secondary">Organize</Button>
          <Menu aria-label="Organize">
            <MenuSection title="Sort">
              <MenuItem id="sort-name">Name</MenuItem>
              <MenuItem id="sort-created">Date created</MenuItem>
            </MenuSection>
            <MenuSection title="Move">
              <MenuItem id="archive">Archive</MenuItem>
              <MenuItem id="locked" isDisabled>
                Locked schema
              </MenuItem>
            </MenuSection>
          </Menu>
        </MenuTrigger>
      ),
    },
    {
      id: 'submenu',
      render: () => (
        <MenuTrigger>
          <Button icon={faDownload}>Export</Button>
          <Menu aria-label="Export">
            <MenuItem id="clipboard" icon={faCopy}>
              Copy to clipboard
            </MenuItem>
            <SubmenuTrigger label="Download as">
              <MenuItem id="csv">CSV</MenuItem>
              <MenuItem id="json">JSON</MenuItem>
              <SubmenuTrigger label="Compressed">
                <MenuItem id="csv-gz">CSV, gzipped</MenuItem>
                <MenuItem id="json-gz">JSON, gzipped</MenuItem>
              </SubmenuTrigger>
            </SubmenuTrigger>
            <MenuSeparator />
            <MenuItem id="sign-out" icon={faArrowRightFromBracket} tone="danger">
              Sign out
            </MenuItem>
          </Menu>
        </MenuTrigger>
      ),
    },
    {
      id: 'open',
      render: () => (
        // Open and non-modal, so the panel and its item states sit next to the rest of the gallery
        // instead of covering it with an underlay.
        <MenuTrigger defaultOpen>
          <Button variant="primary">Open menu</Button>
          <Menu aria-label="Open menu" isNonModal>
            <MenuItem id="new-row" icon={faPencil} description="Adds a row below the selection" shortcut="⌘N">
              New row
            </MenuItem>
            <MenuItem id="delete-row" tone="danger" description="Cannot be undone">
              Delete row
            </MenuItem>
            <MenuSeparator />
            <MenuItem id="locked" isDisabled>
              Locked
            </MenuItem>
          </Menu>
        </MenuTrigger>
      ),
    },
  ],
};
