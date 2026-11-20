import { useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import type { AppCatalogEntry, SourceKind, SourceMeta } from '@riosoma/contracts';
import { Button, Dialog, DialogBody, DialogFooter, Modal } from '@riosoma/ui';
import { HelpDialogTitle } from '../../../docs/HelpDialogTitle';
import { useSourceForm, type EditableSource } from './SourceForm';
import { WebhookAddressShown } from './WebhookPanel';
import './sources.css';

export type { EditableSource } from './SourceForm';

export interface SourceDialogProps {
  appCatalog?: readonly AppCatalogEntry[];
  /** The source being edited; absent while adding one. */
  source?: EditableSource;
  isOpen?: boolean;
  initialKind?: SourceKind;
  onKindChange?(kind: SourceKind): void;
  onSaved(source: SourceMeta): void;
  onClose(): void;
}

/**
 * One dialog for adding and editing a source.  It holds the shared connection form and draws the
 * title, the Test and Save buttons, and, for a brand-new webhook, the address that saves with it.
 * The form's state lives in the hook, which stays mounted while the modal steps aside for help, so
 * an unsaved source is still there on return.
 */
export function SourceDialog({
  appCatalog,
  source,
  isOpen = true,
  initialKind,
  onKindChange,
  onSaved,
  onClose,
}: SourceDialogProps) {
  const { t } = useLingui();
  // A new webhook's address comes back once, with the answer that saves it, and stays until closed.
  const [created, setCreated] = useState<{ meta: SourceMeta; path: string } | null>(null);
  const form = useSourceForm({
    appCatalog,
    source,
    initialKind,
    onKindChange,
    onSaved,
    onCreatedWebhook: (meta, path) => setCreated({ meta, path }),
  });

  if (created)
    return (
      <Modal
        isOpen
        size="lg"
        onOpenChange={(open) => {
          if (!open) onSaved(created.meta);
        }}
        className="rio-sources__dialog"
      >
        <Dialog>
          <HelpDialogTitle
            moduleId="synced-tables"
            section="connecting-a-data-source"
            anchorId="sources.connection"
          >
            {created.meta.name}
          </HelpDialogTitle>
          <DialogBody>
            <p className="rio-sources__note">
              <Trans id="sources.webhook.created">
                {
                  'The webhook is saved.  Give this address to the system that sends posts, then sync a table from the webhook in any database.'
                }
              </Trans>
            </p>
            <WebhookAddressShown path={created.path} />
          </DialogBody>
          <DialogFooter>
            <Button variant="primary" onPress={() => onSaved(created.meta)}>
              <Trans id="sources.webhook.done">Done</Trans>
            </Button>
          </DialogFooter>
        </Dialog>
      </Modal>
    );

  return (
    <Modal
      isOpen={isOpen}
      size="lg"
      isDismissable={!form.busy}
      isKeyboardDismissDisabled={form.busy}
      onOpenChange={(open) => {
        if (!open && !form.busy) onClose();
      }}
      className="rio-sources__dialog"
    >
      <Dialog>
        <HelpDialogTitle
          moduleId={form.kind === 'app' ? 'app-sources' : 'synced-tables'}
          section={form.kind === 'app' ? 'adding-an-app' : 'connecting-a-data-source'}
          anchorId={form.kind === 'app' ? 'sources.app.settings' : 'sources.connection'}
        >
          {source ? source.name : t({ id: 'sources.add', message: 'Add a data source' })}
        </HelpDialogTitle>
        <DialogBody>{form.body}</DialogBody>
        {form.kind ? (
          <DialogFooter>
            <Button
              type="button"
              onPress={() => form.runTest()}
              isDisabled={!form.testReady}
              isPending={form.testing}
            >
              <Trans id="sources.test">Test connection</Trans>
            </Button>
            <Button
              type="button"
              variant="primary"
              onPress={() => form.save()}
              isDisabled={!form.ready}
              isPending={form.saving}
            >
              <Trans id="sources.save">Save</Trans>
            </Button>
          </DialogFooter>
        ) : null}
      </Dialog>
    </Modal>
  );
}
