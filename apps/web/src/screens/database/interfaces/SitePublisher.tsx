import { trustedDocument } from '../../../security/trusted-types';
import { Select, ListBoxItem, SortableList, SortableItem, SegmentedControl } from '@riosoma/ui';
import { useState, type ReactNode } from 'react';
import { useLingui } from '@lingui/react/macro';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DialogTrigger } from 'react-aria-components';
import {
  SiteSettings,
  LIMITS,
  type CustomDomain,
  type InterfaceMeta,
  type PublishedSite,
  type SitePageSettings,
} from '@riosoma/contracts';
import { Button, Dialog, DialogBody, DialogTitle, Modal, TextArea, TextField } from '@riosoma/ui';
import { api, ApiError } from '../../../api';
import type { DatabaseSession, SchemaState } from '../../../data/types';
import { useServerMessage } from '../../../messages/useServerMessage';
import { themes } from '../../../preferences';
import { useSession } from '../../../session';
import { canManageIntegrations } from '../../settings/connections/IntegrationsSettings';
import { AttachmentPicker } from './AttachmentPicker';
import './sites.css';

interface Props {
  value: InterfaceMeta;
  session: DatabaseSession;
  schema: SchemaState;
}
export function SitePublisher({
  trigger,
  isOpen,
  onOpenChange,
  ...props
}: Props & {
  trigger?: ReactNode;
  isOpen?: boolean;
  onOpenChange?(open: boolean): void;
}) {
  const { t } = useLingui();
  const label = t({ id: 'sites.publish', message: 'Publish site' });
  return (
    <DialogTrigger isOpen={isOpen} onOpenChange={onOpenChange}>
      {trigger ?? <Button>{label}</Button>}
      <Modal isDismissable size="lg">
        <Dialog>
          <DialogTitle>{label}</DialogTitle>
          <DialogBody>
            <LoadSite {...props} />
          </DialogBody>
        </Dialog>
      </Modal>
    </DialogTrigger>
  );
}
function LoadSite(props: Props) {
  const { t } = useLingui();
  const message = useServerMessage();
  const result = useQuery({
    queryKey: ['site', props.value.id],
    queryFn: () => api<PublishedSite | null>(`/api/interfaces/${props.value.id}/site`),
  });
  if (result.isPending) return <p>{t({ id: 'sites.loading', message: 'Loading site settings…' })}</p>;
  if (result.error)
    return (
      <p role="alert">
        {message(result.error instanceof ApiError ? result.error.info.messageKey : 'errors.internal')}
      </p>
    );
  return <SiteEditor {...props} initial={result.data ?? null} />;
}
function SiteEditor({ value, session, schema, initial }: Props & { initial: PublishedSite | null }) {
  const { t } = useLingui();
  const message = useServerMessage();
  const client = useQueryClient();
  const [settings, setSettings] = useState<SiteSettings>(
    () =>
      initial?.settings ?? {
        slug: value.id.toLowerCase(),
        title: value.name,
        pages: value.pages.map((page, index) => ({
          pageId: page.id,
          slug: `page-${index + 1}`,
          title: page.name,
          showInNav: true,
          description: '',
          slugFieldId: null,
        })),
        theme: { id: 'palette', scheme: 'house' },
        motion: 'subtle',
        favicon: null,
        logo: null,
        headerButton: null,
        footer: '',
        footerFormat: 'plain',
        socialImage: null,
        noIndex: false,
        domainId: null,
      },
  );
  const [previewPage, setPreviewPage] = useState(settings.pages[0]?.pageId ?? '');
  const [previewWidth, setPreviewWidth] = useState(390);
  const preview = useMutation({
    mutationFn: () =>
      api<{ html: string }>(`/api/interfaces/${value.id}/site/preview`, {
        method: 'POST',
        body: { settings, pageId: previewPage },
      }),
  });
  const [published, setPublished] = useState(initial?.published ?? false);
  const [reserved, setReserved] = useState(Boolean(initial));
  const path = `/api/interfaces/${value.id}/site`;
  const save = useMutation({
    mutationFn: () => api<PublishedSite>(path, { method: 'PUT', body: settings }),
    onSuccess: (site) => {
      setPublished(true);
      setReserved(true);
      client.setQueryData(['site', value.id], site);
    },
  });
  const stop = useMutation({
    mutationFn: () => api<void>(path, { method: 'DELETE' }),
    onSuccess: () => {
      setPublished(false);
      void client.invalidateQueries({ queryKey: ['site', value.id] });
    },
  });
  const index = useQuery({
    queryKey: ['themes', 'index'],
    queryFn: () => themes.list(),
    staleTime: Infinity,
  });
  const manifest = useQuery({
    queryKey: ['themes', settings.theme.id],
    queryFn: () => themes.manifest(settings.theme.id),
    staleTime: Infinity,
  });
  // A domain serves its site in place of every other public page on it, so only the people who
  // manage the organization's domains choose one.  Anyone else keeps the one the site has.
  const domainAdmin = canManageIntegrations(useSession());
  const domains = useQuery({
    queryKey: ['siteDomains'],
    queryFn: () => api<CustomDomain[]>('/api/admin/custom-domains'),
    retry: false,
    enabled: domainAdmin,
  });
  const update = (part: Partial<SiteSettings>) => setSettings((current) => ({ ...current, ...part }));
  const updatePage = (pageId: string, part: Partial<SitePageSettings>) =>
    update({ pages: settings.pages.map((page) => (page.pageId === pageId ? { ...page, ...part } : page)) });
  const busy = save.isPending || stop.isPending;
  const error = save.error ?? stop.error;
  return (
    <div className="rio-site-editor">
      <p>
        {t({
          id: 'sites.exposure',
          message:
            'Anyone can read the selected pages.  Only fields explicitly selected in blocks are published.  Save again to publish interface changes and take over as publisher.',
        })}
      </p>
      <TextField
        label={t({ id: 'sites.title', message: 'Site title' })}
        value={settings.title}
        onChange={(title) => update({ title })}
      />
      <TextField
        label={t({ id: 'sites.address', message: 'Site address' })}
        value={settings.slug}
        isDisabled={reserved}
        onChange={(slug) => update({ slug })}
      />
      <label>
        {t({ id: 'settings.appearance.theme', message: 'Theme' })}
        <select
          value={settings.theme.id}
          onChange={(event) => {
            const theme = index.data?.find((item) => item.id === event.target.value);
            if (theme) update({ theme: { id: theme.id, scheme: theme.defaultScheme } });
          }}
        >
          {index.data?.map((theme) => (
            <option key={theme.id} value={theme.id}>
              {theme.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        {t({ id: 'settings.appearance.scheme', message: 'Color scheme' })}
        <select
          value={settings.theme.scheme}
          onChange={(event) => update({ theme: { ...settings.theme, scheme: event.target.value } })}
        >
          {manifest.data?.schemes.map((scheme) => (
            <option key={scheme.id} value={scheme.id}>
              {scheme.name}
            </option>
          ))}
        </select>
      </label>
      <SegmentedControl
        label={t({ id: 'sites.motion', message: 'Motion' })}
        items={[
          { id: 'subtle', label: t({ id: 'sites.motion.subtle', message: 'Subtle' }) },
          { id: 'none', label: t({ id: 'sites.motion.none', message: 'None' }) },
        ]}
        selectedId={settings.motion}
        onChange={(motion) => {
          if (motion === 'subtle' || motion === 'none') update({ motion });
        }}
      />
      <label>
        <input
          type="checkbox"
          checked={settings.noIndex}
          onChange={(event) => update({ noIndex: event.target.checked })}
        />
        {t({ id: 'sites.noIndex', message: 'Ask search engines not to index this site' })}
      </label>
      {domainAdmin ? (
        <label>
          {t({ id: 'sites.domain', message: 'Custom domain' })}
          <select
            value={settings.domainId ?? ''}
            onChange={(event) => update({ domainId: event.target.value || null })}
          >
            <option value="">{t({ id: 'sites.defaultAddress', message: 'Use the site address' })}</option>
            {domains.data
              ?.filter(
                (domain) =>
                  domain.id === settings.domainId || (domain.verifiedAt && domain.kinds.includes('sites')),
              )
              .map((domain) => (
                <option key={domain.id} value={domain.id}>
                  {domain.host}
                </option>
              ))}
          </select>
        </label>
      ) : (
        <p>
          {settings.domainId
            ? t({
                id: 'sites.domainKept',
                message:
                  'This site keeps its custom domain.  Only the owner or an Integrations administrator can change it.',
              })
            : t({
                id: 'sites.domainAdminOnly',
                message:
                  'Only the owner or an Integrations administrator can serve this site on a custom domain.',
              })}
        </p>
      )}
      <TextArea
        label={t({ id: 'sites.footer', message: 'Footer text' })}
        value={settings.footer}
        maxLength={500}
        onChange={(footer) => update({ footer, footerFormat: 'markdown' })}
      />
      <AttachmentPicker
        label={t({ id: 'sites.logo', message: 'Site logo' })}
        value={settings.logo}
        onChange={(logo) => update({ logo })}
        session={session}
        schema={schema}
      />
      <fieldset>
        <legend>{t({ id: 'sites.headerButton', message: 'Header button' })}</legend>
        {settings.headerButton ? (
          <>
            <TextField
              label={t({ id: 'interfaces.button.label', message: 'Label' })}
              value={settings.headerButton.label}
              maxLength={LIMITS.buttonLabelLength}
              onChange={(label) => update({ headerButton: { ...settings.headerButton!, label } })}
            />
            <SegmentedControl
              label={t({ id: 'interfaces.button.action', message: 'When pressed' })}
              items={[
                { id: 'url', label: t({ id: 'interfaces.button.url', message: 'Open a web address' }) },
                { id: 'page', label: t({ id: 'interfaces.button.page', message: 'Open a page' }) },
              ]}
              selectedId={settings.headerButton.action.kind}
              onChange={(id) =>
                update({
                  headerButton: {
                    ...settings.headerButton!,
                    action:
                      id === 'page' ? { kind: 'page', pageId: value.pages[0]!.id } : { kind: 'url', url: '' },
                  },
                })
              }
            />
            {settings.headerButton.action.kind === 'url' ? (
              <TextField
                label={t({ id: 'interfaces.button.address', message: 'Web address' })}
                value={settings.headerButton.action.url}
                maxLength={LIMITS.urlLength}
                onChange={(url) =>
                  update({ headerButton: { ...settings.headerButton!, action: { kind: 'url', url } } })
                }
              />
            ) : (
              <Select
                label={t({ id: 'interfaces.button.destination', message: 'Destination page' })}
                selectedKey={settings.headerButton.action.pageId}
                onSelectionChange={(key) => {
                  if (typeof key === 'string')
                    update({
                      headerButton: { ...settings.headerButton!, action: { kind: 'page', pageId: key } },
                    });
                }}
              >
                {value.pages.map((page) => (
                  <ListBoxItem key={page.id} id={page.id}>
                    {page.name}
                  </ListBoxItem>
                ))}
              </Select>
            )}
            <Button onPress={() => update({ headerButton: null })}>
              {t({ id: 'interfaces.hero.removeButton', message: 'Remove button' })}
            </Button>
          </>
        ) : (
          <Button onPress={() => update({ headerButton: { label: '', action: { kind: 'url', url: '' } } })}>
            {t({ id: 'sites.addHeaderButton', message: 'Add header button' })}
          </Button>
        )}
      </fieldset>
      <AttachmentPicker
        label={t({ id: 'sites.favicon', message: 'Favicon' })}
        value={settings.favicon}
        onChange={(favicon) => update({ favicon })}
        session={session}
        schema={schema}
      />
      <AttachmentPicker
        label={t({ id: 'sites.socialImage', message: 'Social image' })}
        value={settings.socialImage}
        onChange={(socialImage) => update({ socialImage })}
        session={session}
        schema={schema}
      />
      <fieldset>
        <legend>{t({ id: 'sites.pages', message: 'Published pages, in order' })}</legend>
        <SortableList
          items={settings.pages.map((page) => ({ id: page.pageId, name: page.title }))}
          onMove={(from, to) => {
            const pages = [...settings.pages];
            const [moved] = pages.splice(from, 1);
            pages.splice(to, 0, moved!);
            update({ pages });
          }}
        >
          {settings.pages.map((page) => (
            <SortableItem key={page.pageId} id={page.pageId} as="fieldset">
              <>
                <legend>{value.pages.find((item) => item.id === page.pageId)?.name ?? page.title}</legend>
                <TextField
                  label={t({ id: 'sites.pageTitle', message: 'Page title' })}
                  value={page.title}
                  onChange={(title) => updatePage(page.pageId, { title })}
                />
                <TextField
                  label={t({ id: 'sites.navLabel', message: 'Navigation label' })}
                  value={page.navLabel ?? ''}
                  placeholder={page.title}
                  maxLength={200}
                  onChange={(navLabel) => updatePage(page.pageId, { navLabel: navLabel || undefined })}
                />
                <label>
                  <input
                    type="checkbox"
                    checked={page.showInNav !== false}
                    onChange={(event) => updatePage(page.pageId, { showInNav: event.target.checked })}
                  />
                  {t({ id: 'sites.showInNav', message: 'Show in navigation' })}
                </label>
                <TextField
                  label={t({ id: 'sites.pageAddress', message: 'Page address' })}
                  value={page.slug}
                  onChange={(slug) => updatePage(page.pageId, { slug })}
                />
                <TextField
                  label={t({ id: 'sites.description', message: 'Description' })}
                  value={page.description}
                  onChange={(description) => updatePage(page.pageId, { description })}
                />
                <div>
                  {schema.fieldById.size > 10 ? (
                    <Select
                      label={t({ id: 'sites.slugField', message: 'Field for record addresses' })}
                      selectedKey={page.slugFieldId ?? ''}
                      onSelectionChange={(key) =>
                        updatePage(page.pageId, { slugFieldId: String(key ?? '') || null })
                      }
                    >
                      <ListBoxItem id="">{t({ id: 'sites.recordId', message: 'Record ID' })}</ListBoxItem>
                      {[
                        ...new Set(
                          value.pages
                            .find((item) => item.id === page.pageId)
                            ?.blocks.flatMap((block) => (block.kind === 'records' ? block.fieldIds : [])) ??
                            [],
                        ),
                      ].map((id) => (
                        <ListBoxItem key={id} id={id}>
                          {schema.fieldById.get(id)?.name ?? id}
                        </ListBoxItem>
                      ))}
                    </Select>
                  ) : (
                    <label>
                      {t({ id: 'sites.slugField', message: 'Field for record addresses' })}
                      <select
                        value={page.slugFieldId ?? ''}
                        onChange={(event) =>
                          updatePage(page.pageId, { slugFieldId: event.target.value || null })
                        }
                      >
                        <option value="">{t({ id: 'sites.recordId', message: 'Record ID' })}</option>
                        {[
                          ...new Set(
                            value.pages
                              .find((item) => item.id === page.pageId)
                              ?.blocks.flatMap((block) => (block.kind === 'records' ? block.fieldIds : [])) ??
                              [],
                          ),
                        ].map((id) => (
                          <option key={id} value={id}>
                            {schema.fieldById.get(id)?.name ?? id}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                </div>
                <Button
                  onPress={() =>
                    update({ pages: settings.pages.filter((item) => item.pageId !== page.pageId) })
                  }
                >
                  {t({ id: 'sites.exclude', message: 'Exclude page' })}
                </Button>
              </>
            </SortableItem>
          ))}
        </SortableList>
        {value.pages
          .filter((page) => !settings.pages.some((item) => item.pageId === page.id))
          .map((page) => (
            <Button
              key={page.id}
              onPress={() =>
                update({
                  pages: [
                    ...settings.pages,
                    {
                      pageId: page.id,
                      slug: page.id.toLowerCase(),
                      title: page.name,
                      showInNav: true,
                      description: '',
                      slugFieldId: null,
                    },
                  ],
                })
              }
            >
              {t({ id: 'sites.include', message: `Include ${page.name}` })}
            </Button>
          ))}
      </fieldset>
      <fieldset>
        <legend>{t({ id: 'sites.preview', message: 'Site preview' })}</legend>
        <Select
          label={t({ id: 'sites.previewPage', message: 'Preview page' })}
          selectedKey={previewPage}
          onSelectionChange={(key) => {
            if (typeof key === 'string') setPreviewPage(key);
          }}
        >
          {settings.pages.map((page) => (
            <ListBoxItem key={page.pageId} id={page.pageId}>
              {page.title}
            </ListBoxItem>
          ))}
        </Select>
        <Button
          isDisabled={
            preview.isPending ||
            !SiteSettings.safeParse(settings).success ||
            !settings.pages.some((page) => page.pageId === previewPage)
          }
          onPress={() => preview.mutate()}
        >
          {t({ id: 'sites.previewUpdate', message: 'Update preview' })}
        </Button>
        {preview.error ? (
          <p role="alert">
            {message(preview.error instanceof ApiError ? preview.error.info.messageKey : 'errors.internal')}
          </p>
        ) : null}
        {preview.data ? (
          <>
            <Button onPress={() => setPreviewWidth(previewWidth === 390 ? 1280 : 390)}>
              {previewWidth === 390
                ? t({ id: 'sites.previewWide', message: 'Show desktop preview' })
                : t({ id: 'sites.previewNarrow', message: 'Show phone preview' })}
            </Button>
            <div className="rio-site-preview">
              <iframe
                title={t({ id: 'sites.preview', message: 'Site preview' })}
                sandbox="allow-same-origin"
                srcDoc={trustedDocument(preview.data.html)}
                width={previewWidth}
                height={640}
              />
            </div>
          </>
        ) : null}
      </fieldset>
      {error ? (
        <p role="alert">{message(error instanceof ApiError ? error.info.messageKey : 'errors.internal')}</p>
      ) : null}
      {published ? (
        <p>
          <a href={`/sites/${settings.slug}`} target="_blank" rel="noreferrer">
            {t({ id: 'sites.visit', message: 'Visit site' })}
          </a>
        </p>
      ) : null}
      <Button
        variant="primary"
        isDisabled={busy || !SiteSettings.safeParse(settings).success}
        onPress={() => save.mutate()}
      >
        {t({ id: 'sites.save', message: 'Publish selected pages' })}
      </Button>
      {published ? (
        <Button isDisabled={busy} onPress={() => stop.mutate()}>
          {t({ id: 'sites.unpublish', message: 'Unpublish site' })}
        </Button>
      ) : null}
    </div>
  );
}
