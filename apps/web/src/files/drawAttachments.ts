import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import type { AttachmentMeta } from '@riosoma/contracts';
import { fileIcons, fileKind } from './fileKind';
import './attachments.css';

/** Fixed-size tiles reserve space for the overflow label before filling the cell. */
export function drawAttachments(
  root: HTMLElement,
  ids: readonly string[],
  details: ReadonlyMap<string, AttachmentMeta> | undefined,
  width: number,
): void {
  const available = Math.max(0, width - 16);
  const allFit = ids.length * 28 - 4 <= available;
  const count = allFit ? ids.length : Math.max(0, Math.floor((available - 40) / 28));
  const document = root.ownerDocument;
  root.replaceChildren();
  for (const id of ids.slice(0, count)) {
    const file = details?.get(id);
    const tile = document.createElement('span');
    tile.className = 'rio-cell-file';
    if (!file) {
      tile.dataset.placeholder = '';
      tile.setAttribute('aria-hidden', 'true');
    } else {
      const signature = file.scanSignature ?? '';
      const status =
        file.scanState === 'infected'
          ? i18n._(
              msg({ id: 'files.infected', message: `Removed: this file contained a virus (${signature})` }),
            )
          : file.scanState === 'too_large_allowed'
            ? i18n._(
                msg({
                  id: 'files.tooLargeAllowed',
                  message: 'Too large to scan—download allowed, unscanned',
                }),
              )
            : file.scanState === 'too_large'
              ? i18n._(msg({ id: 'files.tooLargeToScan', message: 'Too large to scan—kept in quarantine' }))
              : file.scanState && file.scanState !== 'clean'
                ? i18n._(msg({ id: 'files.checking', message: 'Checking for viruses' }))
                : '';
      tile.title = status ? `${file.name}: ${status}` : file.name;
      tile.setAttribute('role', 'img');
      tile.setAttribute('aria-label', tile.title);
      if (file.type.startsWith('image/') && file.thumbnails.small) {
        const image = document.createElement('img');
        image.src = file.thumbnails.small;
        image.alt = '';
        tile.append(image);
      } else {
        const kind = fileKind(file);
        tile.dataset.kind = kind;
        const [width, height, , , paths] = fileIcons[kind].icon;
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
        svg.setAttribute('aria-hidden', 'true');
        for (const d of typeof paths === 'string' ? [paths] : paths) {
          const path = document.createElementNS(svg.namespaceURI, 'path');
          path.setAttribute('d', d);
          svg.append(path);
        }
        tile.append(svg);
      }
    }
    root.append(tile);
  }
  if (count < ids.length) {
    const count = ids.length - root.children.length;
    const overflow = document.createElement('span');
    overflow.className = 'rio-cell-file-more';
    overflow.textContent = i18n._(msg({ id: 'files.more', message: `+${count}` }));
    root.append(overflow);
  }
}
