import { Marked, type Token } from 'marked';
import { shortcutKeys } from '../shortcuts/registry';

export interface MacroToken {
  type: 'docMacro';
  raw: string;
  kind: 'ui' | 'keys' | 'doc';
  value: string;
}

// Tables need GitHub's flavor.  Its other additions (bare links, strikethrough, task lists) render
// through the same safe token switch, and raw HTML still never becomes DOM.
const markdown = new Marked({ gfm: true });
markdown.use({
  extensions: [
    {
      name: 'docMacro',
      level: 'inline',
      start: (source) => source.indexOf('{{'),
      tokenizer(source) {
        const match = /^\{\{(ui|keys|doc):([^{}\s]+)\}\}/.exec(source);
        if (!match) return undefined;
        return { type: 'docMacro', raw: match[0], kind: match[1], value: match[2] };
      },
    },
  ],
});

export function parseTokens(body: string): Token[] {
  return markdown.lexer(body);
}

/** The keys for a shortcut the app registers, written the way this device writes them. */
export function resolveShortcutLabel(id: string): string {
  return shortcutKeys(id);
}

export function isExternalLink(href: string): boolean {
  try {
    return new URL(href).protocol === 'https:';
  } catch {
    return false;
  }
}
