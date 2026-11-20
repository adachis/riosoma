import type { RefObject } from 'react';
import { useLingui } from '@lingui/react/macro';
import { ROW_HEIGHTS } from '@riosoma/contracts';
import type { RowHeight } from '@riosoma/contracts';
import { Menu, MenuItem } from '@riosoma/ui';
import { faCheck } from '@fortawesome/free-solid-svg-icons';
import { heightLabels } from './messages';
import './view.css';

export interface RowHeightMenuProps {
  value: RowHeight;
  onChange: (value: RowHeight) => void;
  readOnly?: boolean;
  triggerRef?: RefObject<HTMLElement | null>;
}

export function RowHeightMenu({ value, onChange, readOnly = false, triggerRef }: RowHeightMenuProps) {
  const { t, i18n } = useLingui();
  return (
    <Menu
      triggerRef={triggerRef}
      aria-label={t({ id: 'view.toolbar.rowHeight', message: 'Row height' })}
      selectionMode="single"
      disallowEmptySelection
      selectedKeys={[value]}
      disabledKeys={readOnly ? ROW_HEIGHTS : []}
      onAction={(key) => {
        const height = ROW_HEIGHTS.find((height) => height === key);
        if (!readOnly && height) onChange(height);
      }}
    >
      {ROW_HEIGHTS.map((height) => (
        <MenuItem id={height} key={height} icon={faCheck} className="rio-view-height-item">
          {i18n._(heightLabels[height])}
        </MenuItem>
      ))}
    </Menu>
  );
}
