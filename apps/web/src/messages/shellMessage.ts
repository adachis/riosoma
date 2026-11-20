import { useLingui } from '@lingui/react';
import { msg } from '@lingui/core/macro';
import type { I18n } from '@lingui/core';
import { useEffect } from 'react';
import { messageDescriptor } from './descriptors';
import { loadFeatureCatalog } from '../i18n';

type Params = Record<string, string | number | boolean> | undefined;

const NONE = msg({ id: 'common.none', message: 'none' });
const INTERNAL = msg({ id: 'errors.internal', message: 'Something went wrong on the server.' });
const OFFLINE = msg({
  id: 'errors.offline',
  message: 'Riosoma can’t reach the server.  Check your connection and try again.',
});

/** Turns a server message key and its parameters into text in the reader's language. */
export function serverMessage(i18n: I18n, key: string, params?: Params): string {
  // Demo refusals are announced once by the calm toast, so forms have no inline error to render.
  if (key === 'demo.readOnly') return '';
  if (key === 'formula.function.unknown' && typeof params?.name !== 'string')
    key = 'formula.function.unavailable';
  if (key === 'formula.function.arity' && typeof params?.name !== 'string')
    key = 'formula.function.arguments';
  // Sync history stores the error key alone, so its explanation must stand without a name
  const syncName =
    key === 'sources.sync.columnMissing'
      ? 'column'
      : key === 'sources.sync.objectMissing'
        ? 'object'
        : key === 'sources.sync.keyDuplicate'
          ? 'key'
          : undefined;
  if (syncName && (typeof params?.[syncName] !== 'string' || !params[syncName])) key += '.unnamed';
  const descriptor = messageDescriptor(key) ?? (key === 'errors.offline' ? OFFLINE : INTERNAL);
  const values: Record<string, string | number | boolean> = {};
  for (const [name, value] of Object.entries(params ?? {})) {
    // Lists arrive joined; an empty one reads as "none" rather than a blank.
    values[name] = value === '' ? i18n._(NONE) : value;
  }
  if (key === 'sources.app.secretMissing') {
    const field = params?.fieldMessageId;
    values.hasField = typeof field === 'string' && field.startsWith('sources.app.');
    values.field = values.hasField ? i18n._(field as string) : '';
  }
  if (typeof params?.objectMessageId === 'string' && params.objectMessageId.startsWith('sources.app.'))
    values.object = i18n._(params.objectMessageId, {
      label: params.parent ?? '',
      parent: params.parent ?? '',
    });
  // ICU select keys can't contain hyphens, so provider ids are matched in underscore form.
  if (typeof values.provider === 'string') values.provider = values.provider.replaceAll('-', '_');
  if (
    (key === 'auth.signIn.locked' || key === 'mfa.locked' || key === 'feedback.rateLimited') &&
    typeof params?.retryAfterSeconds === 'number'
  ) {
    values.minutes = Math.max(1, Math.ceil(params.retryAfterSeconds / 60));
  }
  return i18n._({ ...descriptor, values });
}

export function useServerMessage(displayedKey?: string): (key: string, params?: Params) => string {
  const { i18n } = useLingui();
  useEffect(() => {
    if (
      displayedKey &&
      displayedKey !== 'errors.internal' &&
      displayedKey !== 'errors.offline' &&
      !messageDescriptor(displayedKey)
    ) {
      void loadFeatureCatalog().catch(() => {});
    }
  }, [displayedKey]);
  return (key, params) => serverMessage(i18n, key, params);
}
