import { useEffect, useRef, useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import {
  DocumentColumnType,
  DocumentImportPreview,
  type KnowledgeLabel,
  type RioUsage,
} from '@riosoma/contracts';
import { Banner, Button, ListBoxItem, ProgressBar, Select, TextField } from '@riosoma/ui';
import { api, ApiError } from '../../api';
import { serverMessage } from '../../messages/useServerMessage';
import { fieldTypeInfo } from '../database/fields/fieldTypes';
import { FootprintLine } from '../../features/ai-footprint/FootprintLine';

export interface DocumentImportProps {
  databaseId?: string;
  tableId?: string;
  initialOpen?: boolean;
  onChoose(file?: File, types?: DocumentColumnType[]): void;
}

const mediaTypes: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  pdf: 'application/pdf',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

export function previewFile(preview: DocumentImportPreview, name: string): File {
  const quote = (text: string) => `"${text.replaceAll('"', '""')}"`;
  const lines = [
    preview.columns.map((column) => column.name),
    ...preview.rows.map((row) => row.map((cell) => cell.value)),
  ];
  return new File(
    [lines.map((row) => row.map(quote).join(',')).join('\r\n')],
    `${name.replace(/\.[^.]*$/, '')}.csv`,
    { type: 'text/csv' },
  );
}

/** The document remains a draft until its corrected rows enter the ordinary import preview. */
export function DocumentImport({ databaseId, tableId, initialOpen, onChoose }: DocumentImportProps) {
  const { t, i18n } = useLingui();
  const [expanded, setExpanded] = useState(Boolean(initialOpen));
  const [file, setFile] = useState<File>();
  const [label, setLabel] = useState<KnowledgeLabel>('internal');
  const [preview, setPreview] = useState<DocumentImportPreview>();
  const [usage, setUsage] = useState<RioUsage>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const request = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => request.current?.abort(), []);
  const labels = {
    public: t({ id: 'libraries.label.public', message: 'Public' }),
    internal: t({ id: 'libraries.label.internal', message: 'Internal' }),
    confidential: t({ id: 'libraries.label.confidential', message: 'Confidential' }),
    restricted: t({ id: 'libraries.label.restricted', message: 'Restricted' }),
  };
  async function read() {
    if (!file || busy) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError(undefined);
    setPreview(undefined);
    setUsage(undefined);
    try {
      if (file.size > 10 * 1024 * 1024)
        throw new ApiError(413, {
          code: 'payload_too_large',
          messageKey: 'import.document.tooLarge',
          userFault: true,
        });
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = '';
      for (let offset = 0; offset < bytes.length; offset += 8192)
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
      const result = await api<DocumentImportPreview & { usage: RioUsage }>('/api/imports/document', {
        body: {
          data: btoa(binary),
          mediaType: mediaTypes[file.name.split('.').at(-1)?.toLowerCase() ?? ''] ?? file.type,
          label,
          locale: i18n.locale,
          databaseId,
          tableId,
        },
        signal: controller.signal,
      });
      if (!controller.signal.aborted) {
        setPreview(DocumentImportPreview.parse(result));
        setUsage(result.usage);
      }
    } catch (cause) {
      if (!controller.signal.aborted)
        setError(
          serverMessage(i18n, cause instanceof ApiError ? cause.info.messageKey : 'import.document.failed'),
        );
    } finally {
      if (request.current === controller) setBusy(false);
    }
  }
  return (
    <details
      className="rio-document-import"
      open={expanded}
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary>{t({ id: 'import.document.open', message: 'Import from a photo or messy file' })}</summary>
      <p>
        {t({
          id: 'import.document.help',
          message:
            'Rio reads an image, PDF, CSV, or Excel file and proposes a table.  Check the readings before importing.  Your organization’s data rules apply.',
        })}
      </p>
      <label>
        {t({ id: 'import.document.file', message: 'Photo or messy file' })}
        <input
          type="file"
          accept=".png,.jpg,.jpeg,.webp,.pdf,.csv,.tsv,.xlsx"
          disabled={busy}
          onChange={(event) => {
            setFile(event.target.files?.[0]);
            setPreview(undefined);
            setUsage(undefined);
            setError(undefined);
          }}
        />
      </label>
      <Select
        label={t({ id: 'libraries.classification', message: 'Classification' })}
        selectedKey={label}
        isDisabled={busy}
        onSelectionChange={(value) => {
          setLabel(value as KnowledgeLabel);
          setPreview(undefined);
        }}
      >
        {Object.entries(labels).map(([id, name]) => (
          <ListBoxItem key={id} id={id}>
            {name}
          </ListBoxItem>
        ))}
      </Select>
      <Button isDisabled={!file || busy} onPress={() => void read()}>
        {t({ id: 'import.document.read', message: 'Read file' })}
      </Button>
      {busy && (
        <>
          <ProgressBar
            isIndeterminate
            label={t({ id: 'import.document.reading', message: 'Reading the document' })}
          />
          <Button
            onPress={() => {
              request.current?.abort();
              setBusy(false);
            }}
          >
            {t({ id: 'import.cancel', message: 'Cancel' })}
          </Button>
        </>
      )}
      {error && <Banner tone="danger">{error}</Banner>}
      {preview && (
        <>
          <p role="status">
            {t({
              id: 'import.document.review',
              message:
                'Review every row.  Cells marked “Check reading” may be uncertain.  Edit a cell to confirm its reading.',
            })}
          </p>
          <div
            className="rio-import__scroll"
            tabIndex={0}
            role="region"
            aria-label={t({ id: 'import.document.preview', message: 'Readings to review' })}
          >
            <table className="rio-import__table">
              <caption>{t({ id: 'import.document.preview', message: 'Readings to review' })}</caption>
              <thead>
                <tr>
                  {preview.columns.map((column, index) => (
                    <th scope="col" key={index}>
                      <TextField
                        label={t({ id: 'import.column.name', message: 'Field name' })}
                        value={column.name}
                        maxLength={255}
                        onChange={(name) =>
                          setPreview({
                            ...preview,
                            columns: preview.columns.map((entry, i) =>
                              i === index ? { ...entry, name } : entry,
                            ),
                          })
                        }
                      />
                      <Select
                        label={t({ id: 'import.column.type', message: 'Type' })}
                        selectedKey={column.type}
                        onSelectionChange={(type) =>
                          setPreview({
                            ...preview,
                            columns: preview.columns.map((entry, i) =>
                              i === index ? { ...entry, type: type as DocumentColumnType } : entry,
                            ),
                          })
                        }
                      >
                        {DocumentColumnType.options.map((type) => (
                          <ListBoxItem key={type} id={type}>
                            {type === 'dateTime'
                              ? t({ id: 'import.type.dateTime', message: 'Date with time' })
                              : i18n._(fieldTypeInfo(type).name)}
                          </ListBoxItem>
                        ))}
                      </Select>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {preview.rows.map((row, rowIndex) => (
                  <tr key={rowIndex}>
                    {row.map((cell, columnIndex) => {
                      const name = preview.columns[columnIndex]!.name;
                      const number = rowIndex + 1;
                      return (
                        <td
                          key={columnIndex}
                          className={cell.confidence < 0.8 ? 'rio-document-import__uncertain' : undefined}
                        >
                          <TextField
                            label={t({ id: 'import.document.cell', message: `${name}, row ${number}` })}
                            value={cell.value}
                            maxLength={4000}
                            description={
                              cell.confidence < 0.8
                                ? t({ id: 'import.document.uncertain', message: 'Check reading' })
                                : undefined
                            }
                            onChange={(value) =>
                              setPreview({
                                ...preview,
                                rows: preview.rows.map((entry, r) =>
                                  r === rowIndex
                                    ? entry.map((item, c) =>
                                        c === columnIndex ? { value, confidence: 1 } : item,
                                      )
                                    : entry,
                                ),
                              })
                            }
                          />
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {usage && <FootprintLine footprint={usage.footprint ?? null} />}
          <Button
            variant="primary"
            isDisabled={!DocumentImportPreview.safeParse(preview).success}
            onPress={() => {
              onChoose(
                previewFile(preview, file!.name),
                preview.columns.map((column) => column.type),
              );
              setPreview(undefined);
            }}
          >
            {t({ id: 'import.document.use', message: 'Use these rows' })}
          </Button>
        </>
      )}
    </details>
  );
}
