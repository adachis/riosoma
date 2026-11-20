import { Children, isValidElement, useContext, type ReactNode } from 'react';
import { useLingui } from '@lingui/react/macro';
import type { IconDefinition } from '@riosoma/icons';
import { SelectStateContext, ComboBoxStateContext, ListStateContext, type Key } from 'react-aria-components';
import { FilterableList, type PickerItem } from './FilterableList';
import { ListBox, ListBoxItem, ListBoxSection } from './ListBox';

interface SelectItem extends PickerItem {
  key: Key;
}

function CompleteCollection({ options }: { options: SelectItem[] }) {
  const { t } = useLingui();
  const groups = new Map<string, { name?: string; items: SelectItem[] }>();
  for (const item of options) {
    const id = item.group ?? '';
    let group = groups.get(id);
    if (!group) {
      group = { name: item.groupName ?? (id === 'group:' ? undefined : item.group), items: [] };
      groups.set(id, group);
    }
    group.items.push(item);
  }
  return (
    <ListBox>
      {[...groups].map(([id, group]) => (
        <ListBoxSection
          key={`section:${id}`}
          id={`section:${id}`}
          title={
            group.name ?? (groups.size === 1 ? t({ id: 'ui.picker.all', message: 'All items' }) : undefined)
          }
        >
          {group.items.map((item) => (
            <ListBoxItem
              key={item.key}
              id={item.key}
              textValue={item.name}
              description={item.description}
              icon={item.leadingIcon}
              isDisabled={item.isDisabled}
            >
              {item.displayLabel ?? item.name}
            </ListBoxItem>
          ))}
        </ListBoxSection>
      ))}
    </ListBox>
  );
}

/** Static collection elements expose labels without mounting thousands of option nodes */
export function selectItems(children: ReactNode, group?: string): SelectItem[] | null {
  const items: SelectItem[] = [];
  let supported = true;
  Children.forEach(children, (child) => {
    if (child == null || typeof child === 'boolean') return;
    if (!isValidElement(child)) {
      supported = false;
      return;
    }
    if (child.type === ListBoxSection) {
      const props = child.props as { title?: string; children?: ReactNode };
      const nested = selectItems(props.children, props.title);
      if (nested) items.push(...nested);
      else supported = false;
    } else if (child.type === ListBoxItem) {
      const props = child.props as {
        id?: Key;
        textValue?: string;
        children?: ReactNode;
        description?: ReactNode;
        icon?: IconDefinition;
        isDisabled?: boolean;
        group?: string;
        groupName?: string;
      };
      const name = props.textValue ?? (typeof props.children === 'string' ? props.children : undefined);
      if (props.id == null || name == null) {
        supported = false;
        return;
      }
      items.push({
        id: String(props.id),
        key: props.id,
        name,
        displayLabel: props.children,
        description: props.description,
        leadingIcon: props.icon,
        group: props.group ?? group,
        groupName: props.groupName,
        isDisabled: props.isDisabled,
      });
    } else supported = false;
  });
  return supported ? items : null;
}

export function LongSelectOptions({
  options,
  label,
  listId,
}: {
  options: SelectItem[];
  label: string;
  listId?: string;
}) {
  const state = useContext(SelectStateContext);
  // The hidden collection retains every value even when a visible group is collapsed
  if (!state) return <CompleteCollection options={options} />;
  return (
    <ListStateContext.Provider value={null}>
      <FilterableList
        label={label}
        listId={listId}
        items={options.map((item) => ({
          ...item,
          isDisabled: item.isDisabled || state?.disabledKeys.has(item.key),
        }))}
        selectedKeys={[...(state?.selectionManager.selectedKeys ?? [])].map(String)}
        recentlyUsed
        autoFocus
        // Activating the current choice still commits it and closes its picker.
        allowDuplicateSelectionEvents
        onSelectionChange={(keys) => {
          const next = options.find((item) => item.id === [...keys][0])?.key ?? null;
          state?.setSelectedKey(next);
          state?.commitValidation();
          state?.close();
        }}
      />
    </ListStateContext.Provider>
  );
}

export function LongComboBoxOptions({
  options,
  label,
  listId,
  visibleItems,
  onVisibleItemsChange,
}: {
  options: SelectItem[];
  label: string;
  listId?: string;
  visibleItems: PickerItem[] | null;
  onVisibleItemsChange(items: PickerItem[]): void;
}) {
  const state = useContext(ComboBoxStateContext);
  if (!state) {
    // Hidden choices retain their labels while the visible list excludes them from navigation
    const byId = new Map(options.map((item) => [item.id, item]));
    const visibleKeys = new Set(visibleItems?.map((item) => item.id));
    return (
      <CompleteCollection
        options={
          visibleItems == null
            ? options
            : [
                ...visibleItems.flatMap((item) => {
                  const original = byId.get(item.id);
                  return original ? [{ ...original, group: item.group, groupName: item.groupName }] : [];
                }),
                ...options.filter((option) => !visibleKeys.has(option.id)),
              ]
        }
      />
    );
  }
  return (
    <FilterableList
      label={label}
      listId={listId}
      items={options.map((item) => ({
        ...item,
        isDisabled: item.isDisabled || state?.disabledKeys.has(item.key),
      }))}
      selectedKeys={state?.selectedKey == null ? [] : [String(state.selectedKey)]}
      filterValue={state.inputValue === state.selectedItem?.textValue ? '' : state.inputValue}
      hideFilter
      recentlyUsed
      onVisibleItemsChange={onVisibleItemsChange}
      onSelectionChange={(keys) => {
        const next = options.find((item) => item.id === [...keys][0])?.key ?? null;
        state?.setSelectedKey(next);
        state?.close();
      }}
    />
  );
}
