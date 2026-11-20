import { demoRefusal } from '../demo';
import { toast } from '@riosoma/ui';
import { i18n, loadFeatureCatalog } from '../i18n';
import { ApiError } from '../api';
import { serverMessage } from './shellMessage';
import { messageDescriptor } from './descriptors';

export function reportError(error: unknown): void {
  if (demoRefusal(error)) return;
  const key = error instanceof ApiError ? error.info.messageKey : 'errors.internal';
  const show = () =>
    toast.show({
      title: serverMessage(i18n, key, error instanceof ApiError ? error.info.params : undefined),
      tone: 'danger',
    });
  if (key !== 'errors.internal' && key !== 'errors.offline' && !messageDescriptor(key)) {
    void loadFeatureCatalog().then(show, show);
  } else show();
}
