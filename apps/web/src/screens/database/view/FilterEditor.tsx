import { useId, useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import {
  canCompareCurrentField,
  checkCondition,
  CURRENT_PERSON,
  isGroup,
  LIMITS,
  operatorsForField,
} from '@riosoma/contracts';
import type { FieldMeta, FilterCondition, FilterGroup } from '@riosoma/contracts';
import {
  Button,
  ListBoxItem,
  Select,
  Menu,
  MenuItem,
  MenuTrigger,
  SortableTree,
  SortableItem,
  SortableDropZone,
  useSortableMoves,
  type SortableNode,
  type SortableLocation,
  type SortableDirection,
  type SortableItemData,
} from '@riosoma/ui';
import { Icon } from '@riosoma/icons';
import {
  faPlus,
  faSquarePlus,
  faTriangleExclamation,
  faXmark,
  faCopy,
  faEllipsis,
} from '@fortawesome/free-solid-svg-icons';
import type { DatabaseSession } from '../../../data';
import { resultType } from '../../../data/formulas';
import { FieldSelect } from './FieldSelect';
import { FilterValueEditor } from './FilterValueEditor';
import { operatorLabel } from './messages';
import { changeField, conditionsOf, emptyCollaborators, fitValue, newCondition } from './filterValues';
import type { Collaborators } from './filterValues';
import type { AnchorProps } from '../../../demos/anchors';
import { filterTree, moveFilter, duplicateFilter, identifyFilter } from './filterTree';
import './view.css';

export interface FilterEditorProps {
  fields: readonly FieldMeta[];
  currentFields?: readonly FieldMeta[];
  session?: DatabaseSession;
  primaryFieldId?: string;
  collaborators?: Collaborators;
  value: FilterGroup | null;
  onChange: (value: FilterGroup | null) => void;
  readOnly?: boolean;
  readOnlyReason?: string;
  /**
   * Offers "Current person" among the people a person or created-by field can be compared with,
   * for record rules, where it stands for whoever is reading.
   */
  currentPerson?: boolean;
  /** Names the button that adds a condition, where help explains it */
  addAnchor?: AnchorProps;
}

/** A person's ID that fits the ID pattern, so a condition naming the current person checks as valid. */
const SOMEONE = 'usr00000000000000';

function checked(condition: FilterCondition): FilterCondition {
  const value = condition.value;
  if (value === CURRENT_PERSON) return { ...condition, value: SOMEONE };
  if (Array.isArray(value))
    return { ...condition, value: value.map((item) => (item === CURRENT_PERSON ? SOMEONE : item)) };
  return condition;
}

function ConditionRow({
  condition,
  fields,
  currentFields,
  session,
  collaborators,
  readOnly,
  onChange,
  onRemove,
}: {
  condition: FilterCondition;
  fields: readonly FieldMeta[];
  currentFields?: readonly FieldMeta[];
  session?: DatabaseSession;
  collaborators: Collaborators;
  readOnly: boolean;
  onChange: (value: FilterCondition) => void;
  onRemove: () => void;
}) {
  const { t, i18n } = useLingui();
  const warningId = useId();
  const field = fields.find((field) => field.id === condition.fieldId);
  const invalid = condition.currentFieldId
    ? !currentFields?.some(
        (item) =>
          item.id === condition.currentFieldId &&
          field &&
          resultType(item) === resultType(field) &&
          canCompareCurrentField(field, condition.operator) &&
          canCompareCurrentField(item, condition.operator),
      )
    : !checkCondition(field, checked(condition)).valid;
  return (
    <div
      className="rio-view-condition"
      role="group"
      aria-label={t({ id: 'view.filter.operator', message: 'Condition' })}
      aria-describedby={invalid ? warningId : undefined}
    >
      <div className="rio-view-row">
        <FieldSelect
          fields={fields}
          value={condition.fieldId}
          readOnly={readOnly}
          onChange={(id) => {
            const field = fields.find((field) => field.id === id);
            if (field) {
              const { currentFieldId: _current, ...constant } = condition;
              onChange(changeField(constant, field));
            }
          }}
        />
        <Select
          aria-label={t({ id: 'view.filter.operator', message: 'Condition' })}
          isDisabled={readOnly || !field}
          selectedKey={condition.operator}
          onSelectionChange={(key) => {
            const operator = field && operatorsForField(field).find((operator) => operator === key);
            if (field && operator) {
              const { currentFieldId, ...constant } = condition;
              onChange(
                fitValue(
                  {
                    ...constant,
                    operator,
                    ...(currentFieldId && canCompareCurrentField(field, operator) ? { currentFieldId } : {}),
                  },
                  field,
                ),
              );
            }
          }}
        >
          {(field ? operatorsForField(field) : [condition.operator]).map((operator) => (
            <ListBoxItem key={operator} id={operator}>
              {i18n._(operatorLabel(field, operator))}
            </ListBoxItem>
          ))}
        </Select>
        <div className="rio-view-condition-value">
          {field && currentFields && canCompareCurrentField(field, condition.operator) && (
            <Select
              aria-label={t({ id: 'field.lookup.compareWith', message: 'Compare with' })}
              selectedKey={condition.currentFieldId ?? 'constant'}
              isDisabled={readOnly}
              onSelectionChange={(key) => {
                const { currentFieldId: _current, value: _value, ...base } = condition;
                onChange(key === 'constant' ? base : { ...base, currentFieldId: String(key) });
              }}
            >
              <ListBoxItem id="constant">
                {t({ id: 'field.lookup.constant', message: 'A value' })}
              </ListBoxItem>
              {currentFields
                .filter(
                  (item) =>
                    resultType(item) === resultType(field) &&
                    canCompareCurrentField(item, condition.operator),
                )
                .map((item) => (
                  <ListBoxItem key={item.id} id={item.id}>
                    {item.name}
                  </ListBoxItem>
                ))}
            </Select>
          )}
          {field && !condition.currentFieldId && (
            <FilterValueEditor
              key={`${field.id}:${condition.operator}`}
              field={field}
              session={session}
              condition={condition}
              collaborators={collaborators}
              readOnly={readOnly}
              onChange={(value) => {
                if (value === undefined) {
                  const { value: _value, ...next } = condition;
                  onChange(next);
                } else onChange({ ...condition, value });
              }}
            />
          )}
        </div>
        <Button
          icon={faXmark}
          variant="quiet"
          aria-label={t({ id: 'view.filter.removeCondition', message: 'Remove condition' })}
          isDisabled={readOnly}
          onPress={onRemove}
        />
      </div>
      <div
        className="rio-view-warning"
        data-invalid={invalid || undefined}
        id={warningId}
        aria-hidden={!invalid}
      >
        <Icon icon={faTriangleExclamation} />
        {t({ id: 'view.filter.doesNotApply', message: 'This condition doesn’t fit this field’s type.' })}
      </div>
    </div>
  );
}

function MoveMenu({ id, readOnly }: { id: string; readOnly: boolean }) {
  const { t } = useLingui();
  const moves = useSortableMoves();
  const name = moves.item(id)?.data.name ?? '';
  const actions: Array<{ direction: SortableDirection; label: string }> = [
    { direction: 'in', label: t({ id: 'view.filter.moveIn', message: 'Move into the group above' }) },
    { direction: 'out', label: t({ id: 'view.filter.moveOut', message: 'Move out of this group' }) },
  ];
  return (
    <MenuTrigger>
      <Button
        icon={faEllipsis}
        variant="quiet"
        isDisabled={readOnly}
        aria-label={t({ id: 'view.filter.moveMenuFor', message: `Move options for ${name}` })}
      />
      <Menu aria-label={t({ id: 'view.filter.moveMenu', message: 'Move options' })}>
        {actions.map(({ direction, label }) => {
          const target = moves.target(id, direction);
          return (
            <MenuItem
              key={direction}
              isDisabled={readOnly || !target || !moves.canMove(id, target)}
              onAction={() => {
                if (target && !readOnly) moves.move(id, target);
              }}
            >
              {label}
            </MenuItem>
          );
        })}
      </Menu>
    </MenuTrigger>
  );
}

function GroupEditor({
  group,
  depth,
  count,
  fields,
  currentFields,
  session,
  primaryFieldId,
  collaborators,
  readOnly,
  onChange,
  addAnchor,
  parentId = null,
  path = '',
}: {
  /** Names the outermost group's button for adding a condition, for help */
  addAnchor?: AnchorProps;
  parentId?: string | null;
  path?: string;
  group: FilterGroup;
  depth: number;
  count: number;
  fields: readonly FieldMeta[];
  currentFields?: readonly FieldMeta[];
  session?: DatabaseSession;
  primaryFieldId?: string;
  collaborators: Collaborators;
  readOnly: boolean;
  onChange: (value: FilterGroup | null) => void;
}) {
  const { t } = useLingui();
  const and = t({ id: 'view.filter.and', message: 'and' });
  const or = t({ id: 'view.filter.or', message: 'or' });
  const firstField = fields.find((field) => field.id === primaryFieldId) ?? fields[0];
  const atLimit = count >= LIMITS.filterConditions || group.conditions.length >= LIMITS.filterConditions;
  function replace(index: number, value: FilterCondition | FilterGroup | null) {
    const conditions = group.conditions.flatMap((condition, i) =>
      i === index ? (value ? [value] : []) : [condition],
    );
    onChange(conditions.length ? { ...group, conditions } : null);
  }
  return (
    <div className="rio-view-filter-group">
      {filterTree(group, path).map(({ id, data: condition }, index) => (
        <div className="rio-view-filter-entry" key={id}>
          <div className="rio-view-lead">
            {index === 0 ? (
              t({ id: 'view.filter.where', message: 'Where' })
            ) : index === 1 && depth === 1 ? (
              <Select
                aria-label={t({ id: 'view.filter.conjunction', message: 'Match conditions' })}
                selectedKey={group.conjunction}
                isDisabled={readOnly}
                onSelectionChange={(key) => {
                  if (key === 'and' || key === 'or') onChange({ ...group, conjunction: key });
                }}
              >
                <ListBoxItem id="and">{and}</ListBoxItem>
                <ListBoxItem id="or">{or}</ListBoxItem>
              </Select>
            ) : group.conjunction === 'and' ? (
              and
            ) : (
              or
            )}
          </div>
          {isGroup(condition) ? (
            <div className="rio-view-nested">
              <SortableItem id={id} className="rio-view-group-header">
                <>
                  <MoveMenu id={id} readOnly={readOnly} />
                  <Select
                    aria-label={t({ id: 'view.filter.conjunction', message: 'Match conditions' })}
                    selectedKey={condition.conjunction}
                    isDisabled={readOnly}
                    onSelectionChange={(key) => {
                      if (key === 'and' || key === 'or') replace(index, { ...condition, conjunction: key });
                    }}
                  >
                    <ListBoxItem id="and">{and}</ListBoxItem>
                    <ListBoxItem id="or">{or}</ListBoxItem>
                  </Select>
                  <Button
                    icon={faCopy}
                    variant="quiet"
                    isDisabled={
                      readOnly ||
                      count + conditionsOf(condition).length > LIMITS.filterConditions ||
                      group.conditions.length >= LIMITS.filterConditions
                    }
                    aria-label={t({ id: 'view.filter.duplicateGroup', message: 'Duplicate group' })}
                    onPress={() => {
                      const conditions = [...group.conditions];
                      conditions.splice(index + 1, 0, duplicateFilter(condition));
                      onChange({ ...group, conditions });
                    }}
                  />
                  <Button
                    icon={faXmark}
                    variant="quiet"
                    isDisabled={readOnly}
                    aria-label={t({ id: 'view.filter.removeGroup', message: 'Remove group' })}
                    onPress={() => replace(index, null)}
                  />
                </>
              </SortableItem>
              <GroupEditor
                group={condition}
                depth={depth + 1}
                count={count}
                fields={fields}
                currentFields={currentFields}
                session={session}
                primaryFieldId={primaryFieldId}
                collaborators={collaborators}
                readOnly={readOnly}
                parentId={id}
                path={`${path}.${index}`}
                onChange={(next) => replace(index, next)}
              />
            </div>
          ) : (
            <SortableItem id={id} className="rio-view-condition-entry">
              <>
                <div className="rio-view-condition-handle">
                  <MoveMenu id={id} readOnly={readOnly} />
                </div>
                <ConditionRow
                  condition={condition}
                  fields={fields}
                  currentFields={currentFields}
                  session={session}
                  collaborators={collaborators}
                  readOnly={readOnly}
                  onChange={(next) => replace(index, next)}
                  onRemove={() => replace(index, null)}
                />
              </>
            </SortableItem>
          )}
        </div>
      ))}
      <SortableDropZone parentId={parentId} />
      <div className="rio-view-actions">
        <Button
          icon={faPlus}
          isDisabled={readOnly || atLimit || !firstField}
          onPress={() => {
            if (firstField && !atLimit)
              onChange({ ...group, conditions: [...group.conditions, newCondition(firstField)] });
          }}
          {...addAnchor}
          aria-label={t({ id: 'view.filter.addCondition', message: 'Add condition' })}
        />
        <Button
          icon={faSquarePlus}
          isDisabled={readOnly || atLimit || depth >= LIMITS.filterDepth || !firstField}
          onPress={() => {
            if (firstField && !atLimit && depth < LIMITS.filterDepth)
              onChange({
                ...group,
                conditions: [
                  ...group.conditions,
                  {
                    id: crypto.randomUUID().replaceAll('-', ''),
                    conjunction: 'and',
                    conditions: [newCondition(firstField)],
                  },
                ],
              });
          }}
          aria-label={t({ id: 'view.filter.addGroup', message: 'Add condition group' })}
        />
      </div>
    </div>
  );
}

export function FilterEditor({
  fields,
  currentFields,
  session,
  primaryFieldId,
  collaborators: people = emptyCollaborators,
  value,
  onChange,
  readOnly = false,
  readOnlyReason,
  currentPerson = false,
  addAnchor,
}: FilterEditorProps) {
  const { t } = useLingui();
  const collaborators: Collaborators = currentPerson
    ? new Map([
        [CURRENT_PERSON, { name: t({ id: 'permissions.currentPerson', message: 'Current person' }) }],
        ...people,
      ])
    : people;
  // A field with nothing to filter by, such as a button, isn't offered.
  const filterable = fields.filter((field) => operatorsForField(field).length > 0);
  const [identified, setIdentified] = useState(() => ({
    value,
    group: identifyFilter(value ?? { conjunction: 'and', conditions: [] }),
  }));
  let group = identified.group;
  if (value !== identified.value) {
    group = identifyFilter(value ?? { conjunction: 'and', conditions: [] }, identified.group);
    setIdentified({ value, group });
  }
  function named(nodes: ReturnType<typeof filterTree>, prefix = ''): SortableNode<SortableItemData>[] {
    return nodes.map((node, index) => {
      const position = `${prefix}${index + 1}`;
      const entry = node.data;
      const fieldName = !isGroup(entry)
        ? (fields.find((field) => field.id === entry.fieldId)?.name ??
          t({ id: 'view.filter.operator', message: 'Condition' }))
        : '';
      const name = isGroup(node.data)
        ? t({ id: 'view.filter.groupName', message: `Condition group ${position}` })
        : fieldName;
      return {
        id: node.id,
        data: { name },
        ...(node.children ? { children: named([...node.children], `${position}.`) } : {}),
      };
    });
  }
  const tree = named(filterTree(group));
  function onMove(id: string, target: SortableLocation) {
    if (readOnly) return;
    const next = moveFilter(group, id, target);
    if (next !== group) onChange(next);
  }
  return (
    <div className="rio-view-editor">
      {!conditionsOf(value).length && <p>{t({ id: 'view.filter.none', message: 'No filters' })}</p>}
      <SortableTree
        items={tree}
        maxDepth={LIMITS.filterDepth}
        maxChildren={LIMITS.filterConditions}
        onMove={onMove}
        disabledReason={
          readOnly
            ? (readOnlyReason ??
              t({ id: 'sortable.unavailable', message: 'Rearranging is unavailable right now.' }))
            : undefined
        }
      >
        <GroupEditor
          group={group}
          depth={1}
          addAnchor={addAnchor}
          count={conditionsOf(value).length}
          fields={filterable}
          currentFields={currentFields}
          session={session}
          primaryFieldId={primaryFieldId}
          collaborators={collaborators}
          readOnly={readOnly}
          onChange={(next) => {
            if (!readOnly) onChange(conditionsOf(next).length ? next : null);
          }}
        />
      </SortableTree>
    </div>
  );
}
