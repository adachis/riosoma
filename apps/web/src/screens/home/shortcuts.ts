import { recoverImport } from '../../asset-recovery';
import { useLingui } from '@lingui/react/macro';
import { idKind, newId, type ShortcutTarget, type HomeAction } from '@riosoma/contracts';
import { toast } from '@riosoma/ui';
import type { DragEvent } from 'react';
import { api } from '../../api';
import { reportError } from '../../messages/reportError';
import { homeCommand } from './folders';

export const SHORTCUT_DRAG_TYPE = 'application/x-rio-shortcut';
export function shortcutFromHref(href: string): ShortcutTarget | null {
  const parts = href.split('?')[0]!.split('/').filter(Boolean).map(decodeURIComponent);
  if (parts.length !== 3 || idKind(parts[0]!) !== 'database') return null;
  if (parts[1] === 'dashboards' && idKind(parts[2]!) === 'dashboard')
    return { kind: 'dashboard', id: parts[2]! };
  if (parts[1] === 'interfaces' && idKind(parts[2]!) === 'interface')
    return { kind: 'interface', id: parts[2]! };
  return idKind(parts[1]!) === 'table' && idKind(parts[2]!) === 'view'
    ? { kind: 'view', id: parts[2]! }
    : null;
}
export async function shortcutDrop(event: DragEvent, parentId: string | null): Promise<HomeAction | null> {
  const raw = event.dataTransfer.getData(SHORTCUT_DRAG_TYPE);
  if (!raw) return null;
  event.preventDefault();
  event.stopPropagation();
  try {
    const { parseShortcutTarget } = await recoverImport(() => import('./shortcut-validation'));
    const target = parseShortcutTarget(JSON.parse(raw));
    return { kind: 'shortcut.create', shortcutId: newId('shortcut'), parentId, target };
  } catch {
    return null;
  }
}
export function useAddShortcut() {
  const { t } = useLingui();
  return (target: ShortcutTarget, parentId: string | null = null) => {
    void homeCommand({ kind: 'shortcut.create', shortcutId: newId('shortcut'), target, parentId })
      .then(({ id }) =>
        toast.show({
          title: t({ id: 'home.shortcuts.added', message: 'Shortcut added to home' }),
          tone: 'success',
          action: {
            label: t({ id: 'home.deleted.undo', message: 'Undo' }),
            onPress: () => {
              void api(`/api/home/undo/${id}`, { method: 'POST', body: { id: newId('command') } }).catch(
                reportError,
              );
            },
          },
        }),
      )
      .catch(reportError);
  };
}

export function useHomeShortcutDrop() {
  const addShortcut = useAddShortcut();
  return {
    onDragOver(event: DragEvent) {
      if (event.dataTransfer.types.includes(SHORTCUT_DRAG_TYPE)) {
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
      }
    },
    async onDrop(event: DragEvent) {
      const action = await shortcutDrop(event, null);
      if (action?.kind === 'shortcut.create') addShortcut(action.target);
    },
  };
}
