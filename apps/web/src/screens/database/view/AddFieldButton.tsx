import { useLingui } from '@lingui/react/macro';
import type { FieldMeta } from '@riosoma/contracts';
import { Button, Menu, MenuItem, MenuTrigger } from '@riosoma/ui';
import type { IconDefinition } from '@riosoma/icons';
import { faPlus } from '@fortawesome/free-solid-svg-icons';
import { fieldTypeInfo } from '../fields/fieldTypes';
import type { AnchorProps } from '../../../demos/anchors';

/**
 * An add control that opens a field picker first and applies only once a field is chosen, so the
 * grid never re-sorts or breaks into groups on the wrong field before the person picks.  Escape or
 * clicking away adds nothing.  The icon-only button carries a tooltip from its label.
 */
export function AddFieldButton({
  fields,
  label,
  onPick,
  icon = faPlus,
  isDisabled = false,
  anchorProps,
}: {
  /** The fields the person can choose, already narrowed to what this control can add */
  fields: readonly FieldMeta[];
  /** Names the button and its menu, and shows as the button's tooltip */
  label: string;
  onPick: (field: FieldMeta) => void;
  icon?: IconDefinition;
  isDisabled?: boolean;
  anchorProps?: AnchorProps;
}) {
  const { i18n } = useLingui();
  return (
    <MenuTrigger>
      <Button
        icon={icon}
        isDisabled={isDisabled || fields.length === 0}
        aria-label={label}
        {...anchorProps}
      />
      <Menu aria-label={label} includeSortableActions={false}>
        {fields.map((field) => {
          const info = fieldTypeInfo(field.type);
          return (
            <MenuItem
              key={field.id}
              icon={info.icon}
              description={i18n._(info.name)}
              onAction={() => onPick(field)}
            >
              {field.name}
            </MenuItem>
          );
        })}
      </Menu>
    </MenuTrigger>
  );
}
