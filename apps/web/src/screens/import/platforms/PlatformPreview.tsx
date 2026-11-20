import { plural } from '@lingui/core/macro';
import { useLingui } from '@lingui/react/macro';
import type { ImportPlatform, PlatformPreview } from '@riosoma/contracts';
import { fieldTypeInfo } from '../../database/fields/fieldTypes';
import { platformLine } from './PlatformReport';
import './PlatformPreview.css';

export function PlatformPreviewView({
  platform,
  preview,
}: {
  platform: ImportPlatform;
  preview: PlatformPreview;
}) {
  const { t, i18n } = useLingui();
  const line = platformLine(platform);
  return (
    <section
      className="rio-platform-preview"
      aria-label={t({ id: 'import.platform.previewTitle', message: 'Preview tables and fields' })}
    >
      <p>
        {platform === 'smartsheet'
          ? t({
              id: 'import.smartsheet.previewHelp',
              message:
                'The preview reads sheet values to identify field types and known changes.  Files are downloaded during the import.',
            })
          : t({
              id: 'import.platform.previewHelp',
              message:
                'Review the tables and field types before importing.  Record values and attachments are read during the import, and its final report includes any changes found then.',
            })}
      </p>
      {preview.tables.map((table) => (
        <details key={table.id} open>
          <summary>{table.name}</summary>
          <p>
            {t({
              id: 'import.platform.previewCounts',
              message: `${table.name}: ${plural(table.fields.length, { one: '# field', other: '# fields' })}, ${plural(table.views, { one: '# view', other: '# views' })}`,
            })}
          </p>
          <ul>
            {table.fields.map((field, index) => (
              <li key={index}>
                <span>{field.name}</span>
                <span>{i18n._(fieldTypeInfo(field.type).name)}</span>
              </li>
            ))}
          </ul>
        </details>
      ))}
      <ul className="rio-platform-preview__notes">
        {preview.notes.map((item, index) => (
          <li key={index}>{line(i18n, item)}</li>
        ))}
      </ul>
    </section>
  );
}
