import { Fragment, type ReactNode } from 'react';
import { Lexer, type Token } from 'marked';

/** Only web and mail links open.  Anything else, such as `javascript:`, stays plain text. */
function safeHref(href: string): boolean {
  return /^(https?:\/\/|mailto:)/i.test(href.trim());
}

/**
 * What a script shows with `output.markdown`: headings, paragraphs, emphasis, code, links, lists,
 * quotes, and rules.  Everything becomes React elements, so nothing a script writes, or reads from
 * a record, is ever read as HTML, and markup outside the subset stays visible as typed.
 */
export function ScriptMarkdown({ text }: { text: string }) {
  return <div className="rio-script-markdown">{render(Lexer.lex(text, { gfm: false }))}</div>;
}

function render(tokens: readonly Token[]): ReactNode {
  return tokens.map((token, index) => <Fragment key={index}>{renderToken(token)}</Fragment>);
}

function renderToken(token: Token): ReactNode {
  switch (token.type) {
    case 'heading': {
      // The panel's own heading is level two, so the script's sit below it.
      const children = render(token.tokens ?? []);
      return token.depth <= 1 ? (
        <h3>{children}</h3>
      ) : token.depth === 2 ? (
        <h4>{children}</h4>
      ) : (
        <h5>{children}</h5>
      );
    }
    case 'paragraph':
      return <p>{render(token.tokens ?? [])}</p>;
    case 'text':
      return token.tokens ? render(token.tokens) : token.text;
    case 'escape':
      return token.text;
    case 'strong':
      return <strong>{render(token.tokens ?? [])}</strong>;
    case 'em':
      return <em>{render(token.tokens ?? [])}</em>;
    case 'codespan':
      return <code>{token.text}</code>;
    case 'code':
      return (
        <pre>
          <code>{token.text}</code>
        </pre>
      );
    case 'blockquote':
      return <blockquote>{render(token.tokens ?? [])}</blockquote>;
    case 'hr':
      return <hr />;
    case 'br':
      return <br />;
    case 'link':
      return safeHref(token.href) ? (
        <a href={token.href.trim()} target="_blank" rel="noopener noreferrer">
          {render(token.tokens ?? [])}
        </a>
      ) : (
        render(token.tokens ?? [])
      );
    case 'list': {
      const items = (token.items as Array<{ tokens: Token[] }>).map((item, index) => (
        <li key={index}>{render(item.tokens)}</li>
      ));
      return token.ordered ? (
        <ol start={typeof token.start === 'number' ? token.start : 1}>{items}</ol>
      ) : (
        <ul>{items}</ul>
      );
    }
    case 'space':
      return null;
    default:
      return token.raw;
  }
}
