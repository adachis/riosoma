import { RecordLockSettings } from './RecordLockSettings';
import { faPlus, faTrash } from '@fortawesome/free-solid-svg-icons';
import { useLingui } from '@lingui/react/macro';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  isGroup,
  newId,
  type Collaborator,
  type FieldMeta,
  type FilterGroup,
  type RecordRule,
  type TableMeta,
} from '@riosoma/contracts';
import {
  Banner,
  Button,
  Dialog,
  DialogBody,
  DialogFooter,
  DialogTitle,
  Heading,
  Modal,
  Spinner,
  Text,
} from '@riosoma/ui';
import type { DatabaseSession } from '../../../data';
import { ErrorBanner } from '../../../shell/ErrorBanner';
import { errorInfo } from '../../setup/useSetup';
import { FilterEditor } from '../view/FilterEditor';
import { AudiencePicker } from './AudiencePicker';
import { emptyAudience, permissionsKey, saveRecordRules, useTablePermissions } from './api';
import { anchor } from '../../../demos/anchors';
import './permissions.css';

export interface RecordAccessDialogProps {
  session: DatabaseSession;
  table: TableMeta;
  /** The table's fields this person can see, which are the ones a rule's condition can use */
  fields: readonly FieldMeta[];
  collaborators: ReadonlyMap<string, Collaborator>;
  onClose(): void;
}

interface DraftRule {
  id: string;
  roles: RecordRule['roles'];
  users: RecordRule['users'];
  condition: FilterGroup | null;
}

function count(group: FilterGroup | null): number {
  return (group?.conditions ?? []).reduce((n, item) => n + (isGroup(item) ? count(item) : 1), 0);
}

/**
 * Which records people see: each rule names roles and people, and the records they see are the
 * ones its condition matches.  Opened from the table's menu by people who can change the schema.
 */
export function RecordAccessDialog({
  session,
  table,
  fields,
  collaborators,
  onClose,
}: RecordAccessDialogProps) {
  const { t } = useLingui();
  const queryClient = useQueryClient();
  const current = useTablePermissions(table.id);
  const [draft, setDraft] = useState<DraftRule[] | null>(null);
  const rules: DraftRule[] = draft ?? current.data?.records ?? [];
  const incomplete =
    rules.some((rule) => !rule.roles.length && !rule.users.length) ||
    rules.some((rule) => !count(rule.condition));
  const save = useMutation({
    mutationFn: () =>
      saveRecordRules(
        table.id,
        rules.map((rule) => ({
          ...rule,
          condition: rule.condition ?? { conjunction: 'and', conditions: [] },
        })),
      ),
    onSuccess: async (saved) => {
      queryClient.setQueryData(permissionsKey(table.id), saved);
      onClose();
    },
  });
  const change = (index: number, next: Partial<DraftRule>) =>
    setDraft(rules.map((rule, i) => (i === index ? { ...rule, ...next } : rule)));
  const name = table.name;
  return (
    <Modal
      isOpen
      isDismissable
      size="lg"
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog>
        <DialogTitle>
          {t({ id: 'permissions.records.title', message: `Record access for ${name}` })}
        </DialogTitle>
        <DialogBody className="rio-permissions">
          <RecordLockSettings session={session} table={table} fields={fields} />
          <ErrorBanner error={errorInfo(current.error)} />
          <ErrorBanner error={errorInfo(save.error)} />
          {current.isPending ? <Spinner /> : null}
          <Text>
            {t({
              id: 'permissions.records.help',
              message:
                'A rule shows the roles and people it names only the records its condition matches.  Someone several rules name sees the records any of them allows.  People no rule names see every record, and the database’s owners always do.',
            })}
          </Text>
          {current.data ? (
            <ol className="rio-permissions__rules">
              {rules.map((rule, index) => (
                <li key={rule.id} className="rio-permissions__rule">
                  <div className="rio-permissions__rule-head">
                    <Heading level={3}>
                      {t({ id: 'permissions.records.rule', message: `Rule ${index + 1}` })}
                    </Heading>
                    <Button
                      icon={faTrash}
                      variant="quiet"
                      size="sm"
                      aria-label={t({ id: 'permissions.records.remove', message: 'Remove rule' })}
                      onPress={() => setDraft(rules.filter((_, i) => i !== index))}
                    />
                  </div>
                  <AudiencePicker
                    label={t({ id: 'permissions.records.who', message: 'Who this rule is for' })}
                    anchorProps={anchor('permissions.records.who')}
                    value={{ roles: rule.roles, users: rule.users }}
                    collaborators={collaborators}
                    onChange={(audience) => change(index, audience)}
                  />
                  <Heading level={4}>
                    {t({ id: 'permissions.records.where', message: 'They see only records' })}
                  </Heading>
                  <FilterEditor
                    fields={fields}
                    session={session}
                    primaryFieldId={table.primaryFieldId}
                    collaborators={collaborators}
                    currentPerson
                    addAnchor={anchor('permissions.records.condition')}
                    value={rule.condition}
                    onChange={(condition) => change(index, { condition })}
                  />
                </li>
              ))}
            </ol>
          ) : null}
          {current.data ? (
            <Button
              icon={faPlus}
              {...anchor('permissions.records.add')}
              onPress={() =>
                setDraft([...rules, { id: newId('recordRule'), ...emptyAudience(), condition: null }])
              }
              aria-label={t({ id: 'permissions.records.add', message: 'Add rule' })}
            />
          ) : null}
          {incomplete ? (
            <Banner tone="info">
              {t({
                id: 'permissions.records.incomplete',
                message: 'Each rule needs at least one role or person and at least one condition.',
              })}
            </Banner>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <Button isDisabled={save.isPending} onPress={onClose}>
            {t({ id: 'permissions.cancel', message: 'Cancel' })}
          </Button>
          <Button
            variant="primary"
            isDisabled={!current.data || save.isPending || incomplete}
            isPending={save.isPending}
            onPress={() => save.mutate()}
            {...anchor('permissions.save')}
          >
            {t({ id: 'permissions.save', message: 'Save' })}
          </Button>
        </DialogFooter>
      </Dialog>
    </Modal>
  );
}
