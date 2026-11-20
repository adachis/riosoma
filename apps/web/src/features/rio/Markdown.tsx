import { Fragment, useState, type ReactNode } from 'react';
import { Lexer, type Token, type Tokens } from 'marked';
import { Button, Link } from '@riosoma/ui';
import { useLingui } from '@lingui/react/macro';
import { useDemos } from '../../demos/DemoHost';
import { loadModule } from '../../docs/loader';
import { STOPPED } from '../../demos/messages';

function DemoLink({ id, children }: { id: string; children: ReactNode }) {
  const demos = useDemos();
  const { i18n } = useLingui();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  async function start() {
    setBusy(true);
    setFailed(false);
    try {
      const module = await loadModule(id, i18n.locale);
      if (!module?.meta.demo || !demos) throw new Error('Demo unavailable');
      demos.start(module.meta);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Button size="sm" isDisabled={!demos || demos.running || busy} onPress={() => void start()}>
        {children}
      </Button>
      {failed && <span role="alert">{i18n._(STOPPED.failed)}</span>}
    </>
  );
}

function safeLink(href: string): boolean {
  return /^(https?:\/\/|mailto:)/i.test(href) || (/^\/(?!\/)/.test(href) && !href.includes('\\'));
}

/** Unsupported markup stays visible as text; no server text is interpreted as HTML. */
export function Markdown({ text }: { text: string }) {
  const { t } = useLingui();
  function render(tokens: Token[]): ReactNode {
    return tokens.map((token, index) => {
      let content: ReactNode;
      switch (token.type) {
        case 'paragraph':
          content = <p>{render(token.tokens ?? [])}</p>;
          break;
        case 'text':
          content = token.tokens ? render(token.tokens) : token.text;
          break;
        case 'escape':
          content = token.text;
          break;
        case 'em':
          content = <em>{render(token.tokens ?? [])}</em>;
          break;
        case 'strong':
          content = <strong>{render(token.tokens ?? [])}</strong>;
          break;
        case 'codespan':
          content = <code>{token.text}</code>;
          break;
        case 'link':
          content = /^\/\?showMe=[a-z0-9-]+$/.test(token.href) ? (
            <DemoLink id={token.href.slice('/?showMe='.length)}>{render(token.tokens ?? [])}</DemoLink>
          ) : safeLink(token.href) ? (
            <Link href={token.href}>{render(token.tokens ?? [])}</Link>
          ) : (
            render(token.tokens ?? [])
          );
          break;
        case 'list': {
          const items = token.items.map((item: { tokens: Token[] }, itemIndex: number) => (
            <li key={itemIndex}>{render(item.tokens)}</li>
          ));
          content = token.ordered ? <ol start={token.start || 1}>{items}</ol> : <ul>{items}</ul>;
          break;
        }
        case 'table': {
          const table = token as Tokens.Table;
          const headers = table.header.map((cell) => cell.text).join(', ');
          const label = t({ id: 'rio.markdown.table', message: `Comparison: ${headers}` });
          const cell = (entry: { text: string; tokens: Token[] }) => (
            <span className="rio-assistant__value" title={entry.text} aria-label={entry.text}>
              {render(entry.tokens)}
            </span>
          );
          content = (
            <div className="rio-assistant__table-scroll" role="region" tabIndex={0} aria-label={label}>
              <table className="rio-assistant__table">
                <caption className="rio-visually-hidden">{label}</caption>
                <thead>
                  <tr>
                    {table.header.map((entry, column) => (
                      <th scope="col" key={column}>
                        {cell(entry)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {table.rows.map((row, rowIndex) => (
                    <tr key={rowIndex}>
                      {row.map((entry, column) => (
                        <td key={column}>{cell(entry)}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
          break;
        }
        case 'space':
          content = null;
          break;
        default:
          content = token.raw;
      }
      return <Fragment key={index}>{content}</Fragment>;
    });
  }
  return <div className="rio-assistant__markdown">{render(Lexer.lex(text, { gfm: true }))}</div>;
}
