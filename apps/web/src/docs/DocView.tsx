import { Fragment, type ReactNode } from 'react';
import { useLingui } from '@lingui/react';
import { Heading, Link, Text } from '@riosoma/ui';
import type { Token } from 'marked';
import { isExternalLink, parseTokens, resolveShortcutLabel, type MacroToken } from './tokens';
import './docs.css';
import { sectionId } from './context';

export interface DocViewProps {
  body: string;
  onOpen: (id: string) => void;
  titles?: ReadonlyMap<string, string>;
}

export function DocView({ body, onOpen, titles }: DocViewProps) {
  const { i18n } = useLingui();
  function render(tokens: Token[] = [], insideLink = false): ReactNode {
    return tokens.map((token, index) => {
      let content: ReactNode = null;
      switch (token.type) {
        case 'heading': {
          const depth = Math.min(token.depth + 1, 6);
          content = (
            <Heading
              id={`doc-section-${sectionId(token.text)}`}
              tabIndex={-1}
              level={Math.min(depth, 4) as 2 | 3 | 4}
              aria-level={depth}
            >
              {render(token.tokens)}
            </Heading>
          );
          break;
        }
        case 'paragraph':
          content = <Text elementType="p">{render(token.tokens)}</Text>;
          break;
        case 'text':
          content = token.tokens ? render(token.tokens, insideLink) : token.text;
          break;
        case 'escape':
          content = token.text;
          break;
        case 'strong':
          content = <strong>{render(token.tokens, insideLink)}</strong>;
          break;
        case 'em':
          content = <em>{render(token.tokens, insideLink)}</em>;
          break;
        case 'codespan':
          content = <code>{token.text}</code>;
          break;
        case 'code':
          content = (
            <pre>
              <code>{token.text}</code>
            </pre>
          );
          break;
        case 'blockquote':
          content = <blockquote>{render(token.tokens)}</blockquote>;
          break;
        case 'list': {
          const items = token.items.map((item: { tokens: Token[] }, itemIndex: number) => (
            <li key={itemIndex}>{render(item.tokens)}</li>
          ));
          content = token.ordered ? <ol start={token.start || 1}>{items}</ol> : <ul>{items}</ul>;
          break;
        }
        case 'link': {
          const label = render(token.tokens, true);
          const doc = /^\{\{doc:([^{}\s]+)\}\}$/.exec(token.href);
          content = doc ? (
            <Link onPress={() => onOpen(doc[1]!)}>{label}</Link>
          ) : isExternalLink(token.href) ? (
            <Link href={token.href} external>
              {label}
            </Link>
          ) : (
            label
          );
          break;
        }
        case 'docMacro': {
          const macro = token as MacroToken;
          if (macro.kind === 'ui') content = <span className="rio-doc-control">{i18n._(macro.value)}</span>;
          if (macro.kind === 'keys') content = resolveShortcutLabel(macro.value);
          if (macro.kind === 'doc') {
            const title = titles?.get(macro.value) ?? macro.value;
            content = insideLink ? title : <Link onPress={() => onOpen(macro.value)}>{title}</Link>;
          }
          break;
        }
        case 'del':
          content = <del>{render(token.tokens, insideLink)}</del>;
          break;
        case 'table':
          content = (
            <div className="rio-doc-table">
              <table>
                <thead>
                  <tr>
                    {token.header.map((cell: { tokens: Token[] }, cellIndex: number) => (
                      <th key={cellIndex} scope="col">
                        {render(cell.tokens)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {token.rows.map((row: Array<{ tokens: Token[] }>, rowIndex: number) => (
                    <tr key={rowIndex}>
                      {row.map((cell, cellIndex) => (
                        <td key={cellIndex}>{render(cell.tokens)}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
          break;
        case 'hr':
          content = <hr />;
          break;
        case 'br':
          content = <br />;
          break;
        // HTML and unsupported Markdown constructs never become DOM nodes.
        default:
          break;
      }
      return <Fragment key={index}>{content}</Fragment>;
    });
  }
  return <div className="rio-doc-view">{render(parseTokens(body))}</div>;
}
