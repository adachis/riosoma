import { faPen, faXmark } from '@fortawesome/free-solid-svg-icons';
import { useRef, useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import { newId, roleAllows, type HomeAction, type HomeListing, type HomeTag } from '@riosoma/contracts';
import {
  Button,
  Checkbox,
  Dialog,
  DialogBody,
  DialogFooter,
  DialogTitle,
  ListBoxItem,
  Modal,
  Select,
  TextField,
} from '@riosoma/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useSession } from '../../session';
import { ErrorBanner } from '../../shell/ErrorBanner';
import { errorInfo } from '../setup/useSetup';
import { homeCommand } from './folders';
import { api } from '../../api';
import { toast } from '@riosoma/ui';
import { reportError } from '../../grid/view/actions';
import './items.css';

import { TagPill } from './Tags';

export function TagsDialog({ listing, onClose }: { listing: HomeListing; onClose(): void }) {
  const { t } = useLingui();
  const session = useSession();
  const cache = useQueryClient();
  const tagForm = useRef<HTMLFormElement>(null);
  const paletteForm = useRef<HTMLFormElement>(null);
  const [name, setName] = useState('');
  const [color, setColor] = useState('#ff3b30');
  const [visibility, setVisibility] = useState<'shared' | 'private'>('private');
  const [resourceKey, setResourceKey] = useState('');
  const [editing, setEditing] = useState<HomeTag | null>(null);
  const [paletteName, setPaletteName] = useState('');
  const [paletteColor, setPaletteColor] = useState('#007aff');
  const [paletteId, setPaletteId] = useState<string | null>(null);
  const refresh = () => cache.invalidateQueries({ queryKey: ['home'] });
  const change = useMutation({
    mutationFn: (action: HomeAction) => homeCommand(action),
    onSuccess: async ({ id }) => {
      await refresh();
      toast.show({
        title: t({ id: 'home.folders.saved', message: 'Saved' }),
        tone: 'success',
        action: {
          label: t({ id: 'home.deleted.undo', message: 'Undo' }),
          onPress: () => {
            void api(`/api/home/undo/${id}`, { method: 'POST', body: { id: newId('command') } })
              .then(refresh)
              .catch(reportError);
          },
        },
      });
    },
  });
  const resources = [
    ...listing.databases.map((item) => ({ ...item, kind: 'database' as const })),
    ...listing.folders.filter((item) => !item.trashed).map((item) => ({ ...item, kind: 'folder' as const })),
  ];
  const resource = resources.find((item) => `${item.kind}:${item.id}` === resourceKey);
  const colors = [
    { id: '#ff3b30', name: t({ id: 'home.tags.red', message: 'Red' }) },
    { id: '#ff9500', name: t({ id: 'home.tags.orange', message: 'Orange' }) },
    { id: '#ffcc00', name: t({ id: 'home.tags.yellow', message: 'Yellow' }) },
    { id: '#34c759', name: t({ id: 'home.tags.green', message: 'Green' }) },
    { id: '#007aff', name: t({ id: 'home.tags.blue', message: 'Blue' }) },
    { id: '#af52de', name: t({ id: 'home.tags.purple', message: 'Purple' }) },
    { id: '#8e8e93', name: t({ id: 'home.tags.gray', message: 'Gray' }) },
    ...(listing.tagColors ?? []).map((item) => ({ id: item.color, name: item.name })),
  ].filter((item, index, all) => all.findIndex((other) => other.id === item.id) === index);
  if (!colors.some((item) => item.id === color)) colors.push({ id: color, name: color });
  const admin = session?.membership?.kind === 'owner' || session?.membership?.adminRoles?.includes('people');
  return (
    <Modal
      isOpen
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog>
        <DialogTitle>{t({ id: 'home.tags.manage', message: 'Tags and colors' })}</DialogTitle>
        <DialogBody>
          {change.error ? <ErrorBanner error={errorInfo(change.error)} /> : null}
          <Select
            label={t({ id: 'home.tags.item', message: 'Item to tag' })}
            selectedKey={resourceKey || null}
            onSelectionChange={(key) => setResourceKey(String(key))}
          >
            {resources.map((item) => (
              <ListBoxItem
                key={`${item.kind}:${item.id}`}
                id={`${item.kind}:${item.id}`}
                textValue={item.name}
              >
                {item.name}
              </ListBoxItem>
            ))}
          </Select>
          <ul className="rio-home-tag-editor">
            {(listing.tags ?? []).map((tag) => (
              <li key={tag.id}>
                <Checkbox
                  isDisabled={
                    !resource ||
                    change.isPending ||
                    (tag.visibility === 'shared' && !roleAllows(resource.role, 'editRecords'))
                  }
                  isSelected={Boolean(
                    resource &&
                    listing.tagLinks?.some(
                      (link) =>
                        link.tagId === tag.id &&
                        link.resource.kind === resource.kind &&
                        link.resource.id === resource.id,
                    ),
                  )}
                  onChange={(assigned) => {
                    if (resource)
                      change.mutate({
                        kind: 'tag.assign',
                        tagId: tag.id,
                        resource: { kind: resource.kind, id: resource.id },
                        assigned,
                      });
                  }}
                >
                  <TagPill tag={tag} />
                </Checkbox>
                {tag.owned ? (
                  <>
                    <Button
                      variant="quiet"
                      onPress={() => {
                        setEditing(tag);
                        setName(tag.name);
                        setColor(tag.color);
                        setVisibility(tag.visibility);
                      }}
                      aria-label={t({ id: 'home.tags.edit', message: 'Edit tag' })}
                      icon={faPen}
                    />
                    <Button
                      variant="quiet"
                      isDisabled={change.isPending}
                      onPress={() => change.mutate({ kind: 'tag.trash', tagId: tag.id })}
                      aria-label={t({ id: 'home.tags.remove', message: 'Remove tag' })}
                      icon={faXmark}
                    />
                  </>
                ) : null}
              </li>
            ))}
          </ul>
          <form
            ref={tagForm}
            onSubmit={(event) => {
              event.preventDefault();
              const action: HomeAction = editing
                ? { kind: 'tag.update', tagId: editing.id, name, color }
                : { kind: 'tag.create', tagId: newId('tag'), name, color, visibility };
              change.mutate(action, {
                onSuccess: () => {
                  setName('');
                  setEditing(null);
                  requestAnimationFrame(() => tagForm.current?.querySelector('input')?.focus());
                },
              });
            }}
          >
            <TextField
              label={t({ id: 'home.tags.name', message: 'Tag name' })}
              value={name}
              onChange={setName}
              maxLength={120}
              isRequired
            />
            <Select
              label={t({ id: 'home.tags.color', message: 'Tag color' })}
              selectedKey={color}
              onSelectionChange={(key) => setColor(String(key))}
            >
              {colors.map((item) => (
                <ListBoxItem id={item.id} key={item.id}>
                  {item.name}
                </ListBoxItem>
              ))}
            </Select>
            <Select
              label={t({ id: 'home.tags.visibility', message: 'Visibility' })}
              selectedKey={visibility}
              isDisabled={Boolean(editing)}
              onSelectionChange={(key) => setVisibility(key as 'private' | 'shared')}
            >
              <ListBoxItem id="private">{t({ id: 'home.tags.private', message: 'Private' })}</ListBoxItem>
              <ListBoxItem id="shared" isDisabled={session?.membership?.kind === 'guest'}>
                {t({ id: 'home.tags.shared', message: 'Shared' })}
              </ListBoxItem>
            </Select>
            <Button type="submit" isPending={change.isPending} isDisabled={!name.trim()}>
              {editing
                ? t({ id: 'common.save', message: 'Save' })
                : t({ id: 'home.tags.create', message: 'Create tag' })}
            </Button>
            {editing ? (
              <Button
                onPress={() => {
                  setEditing(null);
                  setName('');
                }}
              >
                {t({ id: 'common.cancel', message: 'Cancel' })}
              </Button>
            ) : null}
          </form>
          {admin ? (
            <section>
              <h3>{t({ id: 'home.tags.palette', message: 'Organization colors' })}</h3>
              <ul className="rio-home-tag-editor">
                {listing.tagColors?.map((item) => (
                  <li key={item.id}>
                    <span>{item.name}</span>
                    <Button
                      variant="quiet"
                      onPress={() => {
                        setPaletteId(item.id);
                        setPaletteName(item.name);
                        setPaletteColor(item.color);
                      }}
                      aria-label={t({ id: 'home.tags.editColor', message: 'Edit color' })}
                      icon={faPen}
                    />
                    <Button
                      variant="quiet"
                      isDisabled={change.isPending}
                      onPress={() => change.mutate({ kind: 'tagColor.set', colorId: item.id, value: null })}
                      aria-label={t({ id: 'home.tags.removeColor', message: 'Remove color' })}
                      icon={faXmark}
                    />
                  </li>
                ))}
              </ul>
              <form
                ref={paletteForm}
                onSubmit={(event) => {
                  event.preventDefault();
                  change.mutate(
                    {
                      kind: 'tagColor.set',
                      colorId: paletteId ?? newId('tagColor'),
                      value: { name: paletteName, color: paletteColor },
                    },
                    {
                      onSuccess: () => {
                        setPaletteId(null);
                        setPaletteName('');
                        requestAnimationFrame(() => paletteForm.current?.querySelector('input')?.focus());
                      },
                    },
                  );
                }}
              >
                <TextField
                  label={t({ id: 'home.tags.colorName', message: 'Color name' })}
                  value={paletteName}
                  onChange={setPaletteName}
                  maxLength={120}
                  isRequired
                />
                <TextField
                  label={t({ id: 'home.tags.colorValue', message: 'Color value' })}
                  description={t({
                    id: 'home.tags.hex',
                    message: 'Use a six-digit hex color, starting with #.',
                  })}
                  value={paletteColor}
                  onChange={setPaletteColor}
                  isRequired
                />
                <Button
                  type="submit"
                  isPending={change.isPending}
                  isDisabled={!paletteName.trim() || !/^#[0-9a-fA-F]{6}$/.test(paletteColor)}
                >
                  {t({ id: 'home.tags.saveColor', message: 'Save color' })}
                </Button>
              </form>
            </section>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <Button onPress={onClose}>{t({ id: 'common.close', message: 'Close' })}</Button>
        </DialogFooter>
      </Dialog>
    </Modal>
  );
}
