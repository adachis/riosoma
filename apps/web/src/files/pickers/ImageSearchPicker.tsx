import { useLingui } from '@lingui/react/macro';
import type { ImageSearchResult, ImageSearchStatus } from '@riosoma/contracts';
import { Banner, Button, Dialog, DialogBody, DialogFooter, DialogTitle, Modal, TextField } from '@riosoma/ui';
import { useEffect, useRef, useState } from 'react';
import { ApiError, api } from '../../api';
import { serverMessage, useServerMessage } from '../../messages/useServerMessage';

export function ImageSearchPicker({
  target,
  onAdd,
  onClose,
}: {
  target: { tableId: string; fieldId: string; recordId: string };
  onAdd(url: string, filename?: string, imageSearchToken?: string): Promise<void>;
  onClose(): void;
}) {
  const { t, i18n } = useLingui();
  const message = useServerMessage();
  const [status, setStatus] = useState<ImageSearchStatus>();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<ImageSearchResult[]>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const form = useRef<HTMLFormElement>(null);
  const { tableId, fieldId, recordId } = target;
  useEffect(() => {
    const controller = new AbortController();
    void api<ImageSearchStatus>(
      `/api/knowledge/images/status?${new URLSearchParams({ tableId, fieldId, recordId })}`,
      { signal: controller.signal },
    ).then(setStatus, (error: unknown) => {
      if (!controller.signal.aborted)
        setError(
          error instanceof ApiError
            ? serverMessage(i18n, error.info.messageKey, error.info.params)
            : serverMessage(i18n, 'errors.internal'),
        );
    });
    return () => controller.abort();
  }, [tableId, fieldId, recordId, i18n]);
  useEffect(() => {
    if (!status?.available || busy) return;
    const frame = requestAnimationFrame(() => form.current?.querySelector('input')?.focus());
    return () => cancelAnimationFrame(frame);
  }, [status, busy]);
  async function search() {
    if (busy || !query.trim()) return;
    setBusy(true);
    setError(undefined);
    try {
      setResults(
        await api<ImageSearchResult[]>('/api/knowledge/images', {
          method: 'POST',
          body: { ...target, query },
        }),
      );
    } catch (error) {
      setError(
        error instanceof ApiError
          ? message(error.info.messageKey, error.info.params)
          : message('errors.internal'),
      );
    } finally {
      setBusy(false);
    }
  }
  async function choose(result: ImageSearchResult) {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await onAdd(result.url, undefined, result.token);
      onClose();
    } catch (error) {
      setError(
        error instanceof ApiError
          ? message(error.info.messageKey, error.info.params)
          : message('errors.internal'),
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      isOpen
      isDismissable={!busy}
      isKeyboardDismissDisabled={busy}
      size="lg"
      onOpenChange={(open) => !open && onClose()}
    >
      <Dialog className="rio-image-picker" hideCloseButton={busy}>
        <DialogTitle>{t({ id: 'files.search.title', message: 'Image search' })}</DialogTitle>
        <DialogBody>
          {error && <Banner tone="danger">{error}</Banner>}
          {!status && !error && (
            <p role="status">{t({ id: 'files.search.loading', message: 'Checking image search…' })}</p>
          )}
          {status && !status.available && (
            <>
              <Banner tone="info">{message(status.reason ?? 'knowledge.searchUnavailable')}</Banner>
              <p>
                {t({
                  id: 'files.search.unavailable',
                  message:
                    'Image search needs web search enabled and a configured SearXNG service.  Your organization’s access and classification rules also apply.',
                })}
              </p>
              {status.canConfigure && (
                <a href="/settings/ai">
                  {t({ id: 'files.search.settings', message: 'Open AI and web search settings' })}
                </a>
              )}
            </>
          )}
          {status?.available && (
            <>
              <form
                ref={form}
                onSubmit={(event) => {
                  event.preventDefault();
                  void search();
                }}
              >
                <TextField
                  autoFocus
                  label={t({ id: 'files.search.query', message: 'Search for images' })}
                  value={query}
                  onChange={setQuery}
                  maxLength={1000}
                  isDisabled={busy}
                />
                <Button type="submit" variant="primary" isDisabled={busy || !query.trim()}>
                  {t({ id: 'files.search.search', message: 'Search' })}
                </Button>
              </form>
              <p>
                {t({
                  id: 'files.search.rights',
                  message:
                    'Check the source site’s usage terms before using an image.  A reported license is shown when available.',
                })}
              </p>
              {busy && <p role="status">{t({ id: 'files.search.working', message: 'Working…' })}</p>}
              {results?.length === 0 && (
                <p role="status">
                  {t({ id: 'files.search.empty', message: 'No images found.  Try another search.' })}
                </p>
              )}
              {results && results.length > 0 && (
                <ul
                  className="rio-image-picker__results"
                  aria-label={t({ id: 'files.search.results', message: 'Image search results' })}
                >
                  {results.map((result) => (
                    <li key={result.token}>
                      <img src={result.preview} alt="" loading="lazy" />
                      <a href={result.sourceUrl} target="_blank" rel="noopener noreferrer">
                        {new URL(result.sourceUrl).hostname}
                      </a>
                      {result.license && (
                        <span>
                          {t({ id: 'files.search.license', message: `License: ${result.license}` })}
                        </span>
                      )}
                      <Button isDisabled={busy} onPress={() => void choose(result)}>
                        {result.title}
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </DialogBody>
        <DialogFooter>
          <Button isDisabled={busy} onPress={onClose}>
            {t({ id: 'files.cancel', message: 'Cancel' })}
          </Button>
        </DialogFooter>
      </Dialog>
    </Modal>
  );
}
