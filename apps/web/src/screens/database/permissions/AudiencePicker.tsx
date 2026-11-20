import { normalizeFilter } from '@riosoma/ui';
import { faXmark } from '@fortawesome/free-solid-svg-icons';
import { useLingui } from '@lingui/react/macro';
import { useState } from 'react';
import { DatabaseRole, type Collaborator, type PermissionAudience } from '@riosoma/contracts';
import { Avatar, Button, Checkbox, CheckboxGroup, ComboBox, ListBoxItem } from '@riosoma/ui';
import type { AnchorProps } from '../../../demos/anchors';

/** Roles a rule can name.  Owners always see and change everything, so they aren't offered. */
const ROLES = ['creator', 'editor', 'commenter', 'reader'] as const satisfies readonly DatabaseRole[];

export interface AudiencePickerProps {
  /** What the audience is for, such as "Who can see this field" */
  label: string;
  value: PermissionAudience;
  collaborators: ReadonlyMap<string, Collaborator>;
  isDisabled?: boolean;
  onChange(value: PermissionAudience): void;
  /** Names the picker for help */
  anchorProps?: AnchorProps;
}

/** Roles and people a rule names: checkboxes for roles, and people added by name or address. */
export function AudiencePicker({
  label,
  value,
  collaborators,
  isDisabled,
  onChange,
  anchorProps,
}: AudiencePickerProps) {
  const { t } = useLingui();
  const [query, setQuery] = useState('');
  const names: Record<(typeof ROLES)[number], string> = {
    creator: t({ id: 'share.role.creator', message: 'Creator' }),
    editor: t({ id: 'share.role.editor', message: 'Editor' }),
    commenter: t({ id: 'share.role.commenter', message: 'Commenter' }),
    reader: t({ id: 'share.role.reader', message: 'Reader' }),
  };
  const needle = normalizeFilter(query.trim());
  const candidates = [...collaborators.values()].filter(
    (person) =>
      !value.users.includes(person.id) && normalizeFilter(`${person.name} ${person.email}`).includes(needle),
  );
  return (
    <div className="rio-permissions__audience" role="group" aria-label={label} {...anchorProps}>
      <CheckboxGroup
        label={t({ id: 'permissions.audience.roles', message: 'Everyone with the role' })}
        orientation="horizontal"
        value={value.roles}
        isDisabled={isDisabled}
        onChange={(roles) =>
          onChange({
            ...value,
            roles: roles.flatMap((role) => {
              const parsed = DatabaseRole.safeParse(role);
              return parsed.success ? [parsed.data] : [];
            }),
          })
        }
      >
        {ROLES.map((role) => (
          <Checkbox key={role} value={role}>
            {names[role]}
          </Checkbox>
        ))}
      </CheckboxGroup>
      <ComboBox
        listId="permissions.people"
        label={t({ id: 'permissions.audience.people', message: 'These people' })}
        inputValue={query}
        onInputChange={setQuery}
        selectedKey={null}
        isDisabled={isDisabled}
        onSelectionChange={(key) => {
          const person = candidates.find((candidate) => candidate.id === key);
          if (!person) return;
          onChange({ ...value, users: [...value.users, person.id] });
          setQuery('');
        }}
      >
        {candidates.map((person) => (
          <ListBoxItem
            key={person.id}
            id={person.id}
            textValue={`${person.name} ${person.email}`}
            description={person.email}
          >
            {person.name || person.email}
          </ListBoxItem>
        ))}
      </ComboBox>
      {value.users.length ? (
        <ul className="rio-permissions__people">
          {value.users.map((id) => {
            const person = collaborators.get(id);
            const name =
              person?.name ||
              person?.email ||
              t({ id: 'permissions.audience.former', message: 'Former member' });
            return (
              <li key={id} className="rio-permissions__person">
                <Avatar personId={id} name={name} color="gray" size="sm" />
                <span>{name}</span>
                <Button
                  icon={faXmark}
                  variant="quiet"
                  size="sm"
                  isDisabled={isDisabled}
                  aria-label={t({ id: 'permissions.audience.remove', message: `Remove ${name}` })}
                  onPress={() => onChange({ ...value, users: value.users.filter((user) => user !== id) })}
                />
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
