import { useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import { roleAllows, type InterfacePage } from '@riosoma/contracts';
import { Button, Dialog, DialogBody, DialogFooter, DialogTitle, Modal } from '@riosoma/ui';
import type { DatabaseSession } from '../../../data/types';
import { ScriptField } from '../automations/ScriptField';
import { parsePageJson } from './page-json';

export function PageJsonEditor({
  session,
  interfaceId,
  page,
  pages,
  onClose,
}: {
  session: DatabaseSession;
  interfaceId: string;
  page: InterfacePage;
  pages: readonly InterfacePage[];
  onClose(): void;
}) {
  const { t } = useLingui();
  const [original] = useState(() => JSON.stringify(page));
  const [text, setText] = useState(() => JSON.stringify(page, null, 2));
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const result = parsePageJson(text, page.id, pages);
  const conflict = original !== JSON.stringify(page);
  const path = result.path;
  const save = async () => {
    const latest = session.getSchema().interfaceById.get(interfaceId);
    if (
      !latest ||
      !roleAllows(session.role(), 'editSchema') ||
      original !== JSON.stringify(latest.pages.find((item) => item.id === page.id))
    ) {
      setFailed(true);
      return;
    }
    const checked = parsePageJson(text, page.id, latest.pages);
    if (!checked.page) return;
    setSaving(true);
    setFailed(false);
    try {
      const outcome = await session.run([
        {
          kind: 'interface.update',
          interfaceId,
          pages: latest.pages.map((item) => (item.id === page.id ? checked.page : item)),
        },
      ]).done;
      if (outcome.rejected) setFailed(true);
      else onClose();
    } catch {
      setFailed(true);
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal
      isOpen
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
      size="lg"
    >
      <Dialog>
        <DialogTitle>{t({ id: 'interfaces.json.title', message: 'Edit page JSON' })}</DialogTitle>
        <DialogBody>
          <p>
            {t({
              id: 'interfaces.json.help',
              message:
                'Edit the page name, blocks, and layout.  Keep the page ID.  Saving creates one undoable change.',
            })}
          </p>
          <ScriptField
            label={t({ id: 'interfaces.json.source', message: 'Page JSON' })}
            value={text}
            onChange={setText}
            readOnly={saving}
          />
          {path !== undefined ? (
            <p role="alert">
              {t({
                id: 'interfaces.json.invalid',
                message: `Check the JSON at ${path}.  Use valid page and block settings with unique block IDs.`,
              })}
            </p>
          ) : null}
          {conflict ? (
            <p role="alert">
              {t({
                id: 'interfaces.json.conflict',
                message:
                  'This page changed while you were editing.  Close this editor and open it again to load the latest page.',
              })}
            </p>
          ) : null}
          {failed ? (
            <p role="alert">
              {t({
                id: 'interfaces.json.failed',
                message:
                  'The page could not be saved.  Check your access and the tables, views, and fields referenced by the blocks.',
              })}
            </p>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <Button isDisabled={saving} onPress={onClose}>
            {t({ id: 'field.dialog.cancel', message: 'Cancel' })}
          </Button>
          <Button
            variant="primary"
            isDisabled={saving || !result.page || conflict}
            onPress={() => void save()}
          >
            {t({ id: 'interfaces.json.save', message: 'Save page' })}
          </Button>
        </DialogFooter>
      </Dialog>
    </Modal>
  );
}
