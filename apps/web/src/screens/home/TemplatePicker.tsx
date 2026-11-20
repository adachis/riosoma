import { faXmark } from '@fortawesome/free-solid-svg-icons';
import { plural } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import { TEMPLATE_CATEGORIES, type TemplateCategory, type TemplateSummary } from '@riosoma/contracts';
import { Banner, Button, ConfirmDialog, FilterableList, ListBoxItem, Select, toast } from '@riosoma/ui';
import { useEffect, useId, useState } from 'react';
import { api, ApiError } from '../../api';
import { removeTemplate } from '../../features/archives/api';
import { useServerMessage } from '../../messages/useServerMessage';
import { DatabaseIcon } from './DatabaseIcon';
import './TemplatePicker.css';

export type { TemplateSummary };

type Filter = TemplateCategory | 'all';

/** A template that arrives without a category this app knows is listed with the work templates. */
function categoryOf(template: TemplateSummary): TemplateCategory {
  return TEMPLATE_CATEGORIES.find((category) => category === template.category) ?? 'work';
}

export function TemplatePicker({
  selected,
  onSelect,
  disabled,
  canRemove = false,
}: {
  selected: TemplateSummary | null;
  onSelect(template: TemplateSummary | null): void;
  disabled: boolean;
  /** Offers removing the organization's own templates, which only its admins may do */
  canRemove?: boolean;
}) {
  const { t } = useLingui();
  const message = useServerMessage();
  const headingId = useId();
  const [templates, setTemplates] = useState<TemplateSummary[]>([]);
  const [error, setError] = useState<Error | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [removing, setRemoving] = useState<TemplateSummary | null>(null);
  const [loads, setLoads] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void api<TemplateSummary[]>('/api/templates', { signal: controller.signal }).then(
      (data) => {
        if (!controller.signal.aborted) setTemplates(data);
      },
      (error: Error) => {
        if (!controller.signal.aborted) setError(error);
      },
    );
    return () => controller.abort();
  }, [loads]);
  const labels: Record<TemplateCategory, string> = {
    work: t({ id: 'templates.category.work', message: 'Work' }),
    personal: t({ id: 'templates.category.personal', message: 'Personal' }),
    organizations: t({ id: 'templates.category.organizations', message: 'Organizations' }),
  };
  // The organization's own templates have a place of their own, ahead of the ones Riosoma comes with.
  const own = templates.filter((template) => template.organization);
  const builtIn = templates.filter((template) => !template.organization);
  const categories = TEMPLATE_CATEGORIES.filter((category) =>
    builtIn.some((template) => categoryOf(template) === category),
  );
  // One category's templates read fine as a single list.  Headings and a filter help once there are more.
  const grouped = categories.length > 1;
  const shown =
    grouped && filter !== 'all' ? categories.filter((category) => category === filter) : categories;
  const card = (template: TemplateSummary) => {
    const count = template.tables.length;
    return (
      <button
        key={template.id}
        type="button"
        className="rio-template-card"
        disabled={disabled}
        aria-pressed={selected?.id === template.id}
        onClick={() => onSelect(template)}
      >
        <DatabaseIcon database={template} />
        <span className="rio-template-card__text">
          <strong>{template.name}</strong>
          <span>{template.description}</span>
          <span>
            {t({
              id: 'home.template.tables',
              message: plural(count, { one: '# table', other: '# tables' }),
            })}
          </span>
          <span>{template.tables.join(', ')}</span>
        </span>
      </button>
    );
  };
  return (
    <div className="rio-template-picker">
      <Button onPress={() => onSelect(null)} isDisabled={disabled} aria-pressed={!selected}>
        <Trans id="home.template.scratch">Start from scratch</Trans>
      </Button>
      <div
        role="group"
        aria-label={t({ id: 'home.template.choose', message: 'Start from a template' })}
        className="rio-template-picker__templates"
      >
        {templates.length > 10 ? (
          <>
            <FilterableList
              listId="home.templates"
              label={t({ id: 'home.template.choose', message: 'Start from a template' })}
              items={templates.map((template) => ({
                id: template.id,
                name: template.name,
                description: (
                  <>
                    <DatabaseIcon database={template} />
                    <span>{template.description}</span>
                    <span>{template.tables.join(', ')}</span>
                  </>
                ),
                group: template.organization ? 'organization' : categoryOf(template),
                groupName: template.organization
                  ? t({ id: 'archives.templates.own', message: 'From your organization' })
                  : labels[categoryOf(template)],
              }))}
              selectedKeys={selected ? [selected.id] : []}
              isDisabled={disabled}
              recentlyUsed
              onSelectionChange={(keys) =>
                onSelect(templates.find((template) => keys.has(template.id)) ?? null)
              }
            />
            {selected ? <p>{selected.tables.join(', ')}</p> : null}
            {canRemove && selected?.organization ? (
              <Button
                isDisabled={disabled}
                onPress={() => setRemoving(selected)}
                aria-label={t({ id: 'archives.templates.remove', message: `Remove ${selected.name}` })}
                icon={faXmark}
              />
            ) : null}
          </>
        ) : (
          <>
            <div className="rio-template-picker__header">
              <p className="rio-template-picker__heading">
                <Trans id="home.template.choose">Start from a template</Trans>
              </p>
              {grouped ? (
                <Select
                  className="rio-template-picker__filter"
                  aria-label={t({ id: 'templates.category.label', message: 'Template categories' })}
                  selectedKey={filter}
                  onSelectionChange={(key) =>
                    setFilter(categories.find((category) => category === key) ?? 'all')
                  }
                  isDisabled={disabled}
                >
                  <ListBoxItem id="all">
                    {t({ id: 'templates.category.all', message: 'All templates' })}
                  </ListBoxItem>
                  {categories.map((category) => (
                    <ListBoxItem key={category} id={category}>
                      {labels[category]}
                    </ListBoxItem>
                  ))}
                </Select>
              ) : null}
            </div>
            <div className="rio-template-picker__cards">
              {own.length ? (
                <section className="rio-template-picker__section" aria-labelledby={`${headingId}-own`}>
                  <h3 id={`${headingId}-own`} className="rio-template-picker__category">
                    {t({ id: 'archives.templates.own', message: 'From your organization' })}
                  </h3>
                  <div className="rio-template-picker__grid">
                    {own.map((template) =>
                      canRemove ? (
                        <div key={template.id} className="rio-template-picker__own">
                          {card(template)}
                          <Button
                            className="rio-template-picker__remove"
                            variant="quiet"
                            size="sm"
                            isDisabled={disabled}
                            aria-label={t({
                              id: 'archives.templates.remove',
                              message: `Remove ${template.name}`,
                            })}
                            onPress={() => setRemoving(template)}
                            icon={faXmark}
                          />
                        </div>
                      ) : (
                        card(template)
                      ),
                    )}
                  </div>
                </section>
              ) : null}
              {shown.map((category) => {
                const cards = builtIn.filter((template) => categoryOf(template) === category).map(card);
                if (!grouped || filter !== 'all')
                  return (
                    <div key={category} className="rio-template-picker__grid">
                      {cards}
                    </div>
                  );
                return (
                  <section
                    key={category}
                    className="rio-template-picker__section"
                    aria-labelledby={`${headingId}-${category}`}
                  >
                    <h3 id={`${headingId}-${category}`} className="rio-template-picker__category">
                      {labels[category]}
                    </h3>
                    <div className="rio-template-picker__grid">{cards}</div>
                  </section>
                );
              })}
            </div>
          </>
        )}
        {error ? (
          <Banner tone="danger">
            {message(error instanceof ApiError ? error.info.messageKey : 'errors.internal')}
          </Banner>
        ) : null}
      </div>
      <ConfirmDialog
        isOpen={removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
        title={t({ id: 'archives.templates.removeTitle', message: `Remove ${removing?.name ?? ''}?` })}
        message={t({
          id: 'archives.templates.removeBody',
          message:
            'Nobody in your organization can start from it anymore.  Databases already made from it stay as they are.',
        })}
        confirmLabel={t({ id: 'archives.templates.removeConfirm', message: 'Remove template' })}
        tone="danger"
        onConfirm={async () => {
          if (!removing) return;
          try {
            await removeTemplate(removing.id);
            if (selected?.id === removing.id) onSelect(null);
            setLoads((count) => count + 1);
          } catch (thrown) {
            toast.show({
              tone: 'danger',
              title: message(thrown instanceof ApiError ? thrown.info.messageKey : 'errors.internal'),
            });
            throw thrown;
          }
        }}
      />
    </div>
  );
}
