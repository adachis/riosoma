import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/macro';

export interface DisplayPerson {
  name: string;
  pictureUrl?: string | null;
  deactivated?: boolean;
}

/** Status belongs to the display, so stored names and mention markup stay intact. */
export function personLabel(person: DisplayPerson | undefined, fallback = ''): string {
  const name = person?.name.trim() || fallback;
  if (!person?.deactivated) return name;
  const label = msg({ id: 'ui.avatar.deactivated', message: `${name} (deactivated)` });
  return i18n.locale ? i18n._(label) : label.message!.replace('{name}', name);
}
