import { useLingui } from '@lingui/react/macro';
import type { AutomationStep, NotificationRecipients, OrganizationGroup } from '@riosoma/contracts';
import { Checkbox, ListBoxItem, Select } from '@riosoma/ui';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../../api';
import type { SchemaState } from '../../../data/types';
import { TemplateInput, type TokenCatalog } from './TemplateInput';

type Step = Extract<AutomationStep, { kind: 'sendNotification' }>;

export function NotificationFields({
  step,
  schema,
  catalog,
  triggerTable,
  readOnly,
  onChange,
}: {
  step: Step;
  schema: SchemaState;
  catalog: TokenCatalog;
  triggerTable: string | null;
  readOnly: boolean;
  onChange(step: Step): void;
}) {
  const { t } = useLingui();
  const groups = useQuery({
    queryKey: ['org', 'groups'],
    queryFn: () => api<OrganizationGroup[]>('/api/org/groups'),
    enabled: step.recipients.kind === 'group',
  });
  const fields = (triggerTable ? (schema.fields.get(triggerTable) ?? []) : []).filter(
    (field) => field.type === 'user',
  );
  const kinds: Array<{ id: NotificationRecipients['kind']; name: string }> = [
    { id: 'people', name: t({ id: 'automations.notification.people', message: 'Specific people' }) },
    { id: 'group', name: t({ id: 'automations.notification.group', message: 'A group' }) },
    ...(triggerTable
      ? [
          {
            id: 'personField' as const,
            name: t({ id: 'automations.notification.personField', message: 'People in a person field' }),
          },
          {
            id: 'recordCreator' as const,
            name: t({ id: 'automations.notification.recordCreator', message: 'The record’s creator' }),
          },
        ]
      : []),
    {
      id: 'automationOwner',
      name: t({ id: 'automations.notification.automationOwner', message: 'The automation’s owner' }),
    },
  ];
  const selectKind = (key: string) => {
    const recipients: NotificationRecipients =
      key === 'people'
        ? { kind: 'people', userIds: [] }
        : key === 'group'
          ? { kind: 'group', groupId: groups.data?.[0]?.id ?? '' }
          : key === 'personField'
            ? { kind: 'personField', fieldId: fields[0]?.id ?? '' }
            : key === 'recordCreator'
              ? { kind: 'recordCreator' }
              : { kind: 'automationOwner' };
    onChange({ ...step, recipients });
  };
  const recipients = step.recipients;
  return (
    <>
      <Select
        label={t({ id: 'automations.notification.recipients', message: 'Who receives it' })}
        selectedKey={recipients.kind}
        isDisabled={readOnly}
        onSelectionChange={(key) => {
          if (key !== null) selectKind(String(key));
        }}
      >
        {kinds.map((kind) => (
          <ListBoxItem key={kind.id} id={kind.id}>
            {kind.name}
          </ListBoxItem>
        ))}
      </Select>
      {recipients.kind === 'people' ? (
        <fieldset>
          <legend>{t({ id: 'automations.notification.people', message: 'Specific people' })}</legend>
          {[...schema.collaborators.values()].map((person) => (
            <Checkbox
              key={person.id}
              isSelected={recipients.userIds.includes(person.id)}
              isDisabled={
                readOnly || (!recipients.userIds.includes(person.id) && recipients.userIds.length >= 50)
              }
              onChange={(selected) =>
                onChange({
                  ...step,
                  recipients: {
                    ...recipients,
                    userIds: selected
                      ? [...recipients.userIds, person.id]
                      : recipients.userIds.filter((id) => id !== person.id),
                  },
                })
              }
            >
              {person.name}
            </Checkbox>
          ))}
        </fieldset>
      ) : null}
      {recipients.kind === 'group' ? (
        <Select
          label={t({ id: 'automations.notification.groupName', message: 'Group' })}
          selectedKey={recipients.groupId || null}
          isDisabled={readOnly}
          onSelectionChange={(key) => {
            if (key !== null) onChange({ ...step, recipients: { ...recipients, groupId: String(key) } });
          }}
        >
          {(groups.data ?? []).map((group) => (
            <ListBoxItem key={group.id} id={group.id}>
              {group.name}
            </ListBoxItem>
          ))}
        </Select>
      ) : null}
      {recipients.kind === 'personField' ? (
        <Select
          label={t({ id: 'automations.notification.field', message: 'Person field' })}
          selectedKey={recipients.fieldId || null}
          isDisabled={readOnly}
          onSelectionChange={(key) => {
            if (key !== null) onChange({ ...step, recipients: { ...recipients, fieldId: String(key) } });
          }}
        >
          {fields.map((field) => (
            <ListBoxItem key={field.id} id={field.id}>
              {field.name}
            </ListBoxItem>
          ))}
        </Select>
      ) : null}
      <TemplateInput
        label={t({ id: 'automations.notification.title', message: 'Notification title' })}
        value={step.title}
        catalog={catalog}
        readOnly={readOnly}
        onChange={(title) => onChange({ ...step, title })}
      />
      <TemplateInput
        label={t({ id: 'automations.step.body', message: 'Message' })}
        value={step.body}
        catalog={catalog}
        readOnly={readOnly}
        multiline
        onChange={(body) => onChange({ ...step, body })}
      />
      <Select
        label={t({ id: 'automations.notification.link', message: 'Notification link' })}
        selectedKey={step.link.kind}
        isDisabled={readOnly}
        onSelectionChange={(key) => {
          if (key === 'record' || key === 'none') onChange({ ...step, link: { kind: key } });
          if (key === 'custom') onChange({ ...step, link: { kind: 'custom', url: '' } });
        }}
      >
        <ListBoxItem id="record">
          {t({ id: 'automations.notification.recordLink', message: 'The triggering record' })}
        </ListBoxItem>
        <ListBoxItem id="none">
          {t({ id: 'automations.notification.noLink', message: 'No link' })}
        </ListBoxItem>
        <ListBoxItem id="custom">
          {t({ id: 'automations.notification.customLink', message: 'A custom link' })}
        </ListBoxItem>
      </Select>
      {step.link.kind === 'custom' ? (
        <TemplateInput
          label={t({ id: 'automations.step.url', message: 'Address' })}
          value={step.link.url}
          catalog={catalog}
          readOnly={readOnly}
          onChange={(url) => onChange({ ...step, link: { kind: 'custom', url } })}
        />
      ) : null}
      <p>
        {t({
          id: 'automations.notification.access',
          message:
            'Each person’s notification preferences apply.  Links and field values follow their access.',
        })}
      </p>
    </>
  );
}
