import { Fragment, type ReactNode } from 'react';
import { parseSiteMarkdown, safeLink, type SiteMarkdownInline } from '@riosoma/contracts';

/** The same allowlisted tree supplies the designer and public renderer. */
export function MarkdownText({ text, heading = false }: { text: string; heading?: boolean }) {
  const render = (nodes: SiteMarkdownInline[]): ReactNode =>
    nodes.map((node, index) => {
      const child = () => ('children' in node ? render(node.children) : null);
      let content;
      switch (node.kind) {
        case 'text':
          content = node.text;
          break;
        case 'break':
          content = <br />;
          break;
        case 'em':
          content = <em>{child()}</em>;
          break;
        case 'strong':
          content = <strong>{child()}</strong>;
          break;
        case 'link':
          content = safeLink(node.href) ? (
            <a href={node.href} rel="noopener noreferrer">
              {child()}
            </a>
          ) : (
            child()
          );
          break;
      }
      return <Fragment key={index}>{content}</Fragment>;
    });
  return parseSiteMarkdown(text).map((node, index) => {
    if (node.kind === 'paragraph')
      return heading ? (
        <h3 className="rio-interface-text__heading" key={index}>
          {render(node.children)}
        </h3>
      ) : (
        <p key={index}>{render(node.children)}</p>
      );
    return node.ordered ? (
      <ol key={index} start={node.start}>
        {node.items.map((item, slot) => (
          <li key={slot}>{render(item)}</li>
        ))}
      </ol>
    ) : (
      <ul key={index}>
        {node.items.map((item, slot) => (
          <li key={slot}>{render(item)}</li>
        ))}
      </ul>
    );
  });
}
