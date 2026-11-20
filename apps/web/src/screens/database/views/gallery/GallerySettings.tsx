import { faIdCard } from '@fortawesome/free-solid-svg-icons';
import { SettingsTrigger } from '../../view/ToolbarSettings';
import { useLingui } from '@lingui/react/macro';
import { Dialog } from 'react-aria-components';
import { Button, ListBoxItem, Popover, Select } from '@riosoma/ui';
import type { ViewComponentProps } from '../types';
import './gallery.css';

export function GallerySettings({ view, fields, canEdit, onConfig }: ViewComponentProps) {
  const { t } = useLingui();
  const settings = view.config.gallery;
  const label = t({ id: 'gallery.cards', message: 'Cards' });
  return (
    <SettingsTrigger label={label} icon={faIdCard}>
      <Button variant="quiet" isDisabled={!canEdit}>
        {label}
      </Button>
      <Popover placement="bottom start">
        <Dialog aria-label={label} className="rio-gallery-view-settings">
          <Select
            isDisabled={!canEdit}
            label={t({ id: 'gallery.cover', message: 'Cover image' })}
            selectedKey={settings.coverFieldId ?? ''}
            onSelectionChange={(key) =>
              onConfig({ gallery: { ...settings, coverFieldId: key ? String(key) : null } })
            }
          >
            <ListBoxItem id="">{t({ id: 'gallery.cover.none', message: 'None' })}</ListBoxItem>
            {fields
              .filter((field) => field.type === 'attachment')
              .map((field) => (
                <ListBoxItem key={field.id} id={field.id}>
                  {field.name}
                </ListBoxItem>
              ))}
          </Select>
          <Select
            isDisabled={!canEdit}
            label={t({ id: 'gallery.coverFit', message: 'Fit' })}
            selectedKey={settings.coverFit}
            onSelectionChange={(key) => {
              if (key === 'crop' || key === 'fit') onConfig({ gallery: { ...settings, coverFit: key } });
            }}
          >
            <ListBoxItem id="crop">{t({ id: 'gallery.coverFit.crop', message: 'Crop to fill' })}</ListBoxItem>
            <ListBoxItem id="fit">
              {t({ id: 'gallery.coverFit.fit', message: 'Show whole image' })}
            </ListBoxItem>
          </Select>
          <Select
            isDisabled={!canEdit}
            label={t({ id: 'gallery.size', message: 'Card size' })}
            selectedKey={settings.cardSize}
            onSelectionChange={(key) => {
              if (key === 'small' || key === 'medium' || key === 'large')
                onConfig({ gallery: { ...settings, cardSize: key } });
            }}
          >
            <ListBoxItem id="small">{t({ id: 'gallery.size.small', message: 'Small' })}</ListBoxItem>
            <ListBoxItem id="medium">{t({ id: 'gallery.size.medium', message: 'Medium' })}</ListBoxItem>
            <ListBoxItem id="large">{t({ id: 'gallery.size.large', message: 'Large' })}</ListBoxItem>
          </Select>
        </Dialog>
      </Popover>
    </SettingsTrigger>
  );
}
