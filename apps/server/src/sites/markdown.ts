import { parseSiteMarkdown, type SiteMarkdownInline, type SiteSettings } from '@riosoma/contracts';
import { escapeHtml } from '../reports/messages.js';
import { siteLink } from './links.js';

export function markdownHtml(
  text: string,
  settings: SiteSettings,
  base: string,
  origin: string,
  slug: string,
  heading = false,
): string {
  const render = (nodes: SiteMarkdownInline[]): string =>
    nodes
      .map((node): string => {
        switch (node.kind) {
          case 'text':
            return escapeHtml(node.text);
          case 'break':
            return '<br>';
          case 'em':
          case 'strong':
            return `<${node.kind}>${render(node.children)}</${node.kind}>`;
          case 'link': {
            const link = siteLink(node.href, settings, base, origin, slug);
            return link
              ? `<a href="${escapeHtml(link.href)}"${link.external ? ' rel="noopener noreferrer"' : ''}>${render(node.children)}</a>`
              : render(node.children);
          }
        }
      })
      .join('');
  return parseSiteMarkdown(text)
    .map((node) => {
      if (node.kind === 'paragraph') {
        const tag = heading ? 'h2' : 'p';
        return `<${tag}>${render(node.children)}</${tag}>`;
      }
      const tag = node.ordered ? 'ol' : 'ul';
      return `<${tag}${node.ordered ? ` start="${node.start}"` : ''}>${node.items.map((item) => `<li>${render(item)}</li>`).join('')}</${tag}>`;
    })
    .join('');
}
