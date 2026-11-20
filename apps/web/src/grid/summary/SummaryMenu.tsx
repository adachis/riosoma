import { faCheck } from '@fortawesome/free-solid-svg-icons';
import { useLingui } from '@lingui/react/macro';
import { summaryKindsFor, type FieldMeta, type SummaryKind } from '@riosoma/contracts';
import { MenuItem, Popover } from '@riosoma/ui';
import { useMemo } from 'react';
import { Menu as AriaMenu } from 'react-aria-components';
import { SUMMARY_LABELS, summaryKindOf } from './text';
import './summary.css';

export interface SummaryMenuProps {
  field: FieldMeta;
  summaries: Readonly<Record<string, SummaryKind>>;
  /** The footer cell, which the menu opens against */
  anchor: HTMLElement;
  onChoose(kind: SummaryKind): void;
  onClose(): void;
}

/** A column's footer menu: the summaries its field can show, with the chosen one checked. */
export function SummaryMenu({ field, summaries, anchor, onChoose, onClose }: SummaryMenuProps) {
  const { t, i18n } = useLingui();
  const trigger = useMemo(() => ({ current: anchor }), [anchor]);
  const kinds = summaryKindsFor(field);
  const name = field.name;
  return (
    <Popover
      isOpen
      triggerRef={trigger}
      placement="top start"
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <AriaMenu
        autoFocus="first"
        className="rio-menu"
        aria-label={t({ id: 'grid.summary.menu', message: `Summary for ${name}` })}
        selectionMode="single"
        disallowEmptySelection
        selectedKeys={[summaryKindOf(field, summaries)]}
        onAction={(key) => {
          const kind = kinds.find((item) => item === key);
          if (kind) onChoose(kind);
        }}
      >
        {kinds.map((kind) => (
          <MenuItem key={kind} id={kind} icon={faCheck} className="rio-grid-summary-item">
            {i18n._(SUMMARY_LABELS[kind])}
          </MenuItem>
        ))}
      </AriaMenu>
    </Popover>
  );
}
