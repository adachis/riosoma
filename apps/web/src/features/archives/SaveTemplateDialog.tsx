import { Trans, useLingui } from '@lingui/react/macro';
import {
  ARCHIVE_LIMITS,
  LIMITS,
  TEMPLATE_CATEGORIES,
  TemplateCategory,
  type OrgTemplateCreate,
} from '@riosoma/contracts';
import {
  Banner,
  Button,
  Dialog,
  DialogBody,
  DialogFooter,
  DialogTitle,
  ListBoxItem,
  Modal,
  NumberField,
  Select,
  TextArea,
  TextField,
  toast,
} from '@riosoma/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ApiError } from '../../api';
import { useServerMessage } from '../../messages/useServerMessage';
import { saveAsTemplate } from './api';
import './archives.css';

/**
 * Saves a database as a template for everyone in the organization: its structure, with its first
 * few records in each table as samples when asked.  Comments never come along.
 */
export function SaveTemplateDialog({
  databaseId,
  databaseName,
  onClose,
}: {
  databaseId: string;
  databaseName: string;
  onClose(): void;
}) {
  const { t } = useLingui();
  const message = useServerMessage();
  const client = useQueryClient();
  const [name, setName] = useState(databaseName);
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState<TemplateCategory>('work');
  const [samples, setSamples] = useState(0);
  const labels: Record<TemplateCategory, string> = {
    work: t({ id: 'templates.category.work', message: 'Work' }),
    personal: t({ id: 'templates.category.personal', message: 'Personal' }),
    organizations: t({ id: 'templates.category.organizations', message: 'Organizations' }),
  };
  const save = useMutation({
    mutationFn: () => {
      const input: OrgTemplateCreate = {
        name: name.trim(),
        description: description.trim(),
        category,
        samples: Number.isFinite(samples) ? samples : 0,
      };
      return saveAsTemplate(databaseId, input);
    },
    onSuccess: async (template) => {
      const saved = template.name;
      toast.show({
        title: t({ id: 'archives.template.saved', message: `Saved ${saved} as a template` }),
        tone: 'success',
      });
      await client.invalidateQueries({ queryKey: ['templates'] });
      onClose();
    },
  });
  return (
    <Modal
      isOpen
      isDismissable
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog>
        <DialogTitle>
          <Trans id="archives.template.title">Save as a template</Trans>
        </DialogTitle>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!name.trim() || save.isPending) return;
            save.mutate();
          }}
        >
          <DialogBody className="rio-archives">
            <p className="rio-archives__note">
              {t({
                id: 'archives.template.intro',
                message:
                  'Everyone in your organization can start a new database from this template.  It keeps the tables, fields, views, dashboards, interfaces, and automations, which start turned off.',
              })}
            </p>
            <TextField
              label={t({ id: 'archives.template.name', message: 'Template name' })}
              value={name}
              onChange={setName}
              maxLength={LIMITS.nameLength}
              isRequired
              isDisabled={save.isPending}
            />
            <TextArea
              label={t({ id: 'archives.template.description', message: 'Description' })}
              value={description}
              onChange={setDescription}
              maxLength={500}
              isDisabled={save.isPending}
            />
            <Select
              label={t({ id: 'archives.template.category', message: 'Category' })}
              selectedKey={category}
              onSelectionChange={(key) => {
                const parsed = TemplateCategory.safeParse(key);
                if (parsed.success) setCategory(parsed.data);
              }}
              isDisabled={save.isPending}
            >
              {TEMPLATE_CATEGORIES.map((item) => (
                <ListBoxItem key={item} id={item}>
                  {labels[item]}
                </ListBoxItem>
              ))}
            </Select>
            <NumberField
              label={t({ id: 'archives.template.samples', message: 'Sample records from each table' })}
              description={t({
                id: 'archives.template.samplesHelp',
                message: 'The first records of each table come along as examples.  Leave it at 0 for none.',
              })}
              value={samples}
              onChange={setSamples}
              minValue={0}
              maxValue={ARCHIVE_LIMITS.templateSamples}
              step={1}
              isDisabled={save.isPending}
            />
            {save.error ? (
              <Banner tone="danger">
                {message(
                  save.error instanceof ApiError ? save.error.info.messageKey : 'errors.internal',
                  save.error instanceof ApiError ? save.error.info.params : undefined,
                )}
              </Banner>
            ) : null}
          </DialogBody>
          <DialogFooter>
            <Button onPress={onClose} isDisabled={save.isPending}>
              <Trans id="home.dialog.cancel">Cancel</Trans>
            </Button>
            <Button type="submit" variant="primary" isPending={save.isPending} isDisabled={!name.trim()}>
              <Trans id="archives.template.save">Save template</Trans>
            </Button>
          </DialogFooter>
        </form>
      </Dialog>
    </Modal>
  );
}
