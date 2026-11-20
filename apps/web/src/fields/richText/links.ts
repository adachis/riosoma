import { linkTarget } from '../../grid/cells/renderers';
import { safeLinkHref } from './markdown';

/**
 * What someone typed as a link's address, as the address to store, or null when it can't be one.
 * A bare domain such as example.com gets https:// in front of it, and an email address becomes a
 * mailto: link, the way the grid treats URL and email fields.
 */
export function linkFromInput(input: string): string | null {
  const text = input.trim();
  if (/^mailto:/i.test(text)) return safeLinkHref(text);
  const address = linkTarget('email', text) ?? linkTarget('url', text);
  return address === null ? null : safeLinkHref(address);
}
