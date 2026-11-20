import { Fragment, createElement, type ReactNode } from 'react';
import { useLingui } from '@lingui/react/macro';
import { Separator, Toolbar, cx } from '@riosoma/ui';
import { markdownToDoc, safeLinkHref, type RichBlock, type RichInline } from './markdown';
import { LoadingState } from '../../shell/lazy';
import './richText.css';

function inline(content: RichInline[] = []): ReactNode {
  return content.map((part, index) => {
    if (part.type === 'hardBreak') return <br key={index} />;
    let text: ReactNode = part.text;
    for (const mark of [...(part.marks ?? [])].reverse()) {
      switch (mark.type) {
        case 'bold':
          text = <strong>{text}</strong>;
          break;
        case 'italic':
          text = <em>{text}</em>;
          break;
        case 'strike':
          text = <s>{text}</s>;
          break;
        case 'code':
          text = <code>{text}</code>;
          break;
        case 'link': {
          const href = safeLinkHref(mark.attrs.href);
          if (href)
            text = (
              <a href={href} title={mark.attrs.title ?? undefined}>
                {text}
              </a>
            );
          break;
        }
      }
    }
    return <Fragment key={index}>{text}</Fragment>;
  });
}

function blocks(content: RichBlock[]): ReactNode {
  return content.map((block, index) => {
    switch (block.type) {
      case 'paragraph':
        return (
          <p key={index}>
            {inline(block.content)}
            {!block.content?.length || block.content.at(-1)?.type === 'hardBreak' ? <br /> : null}
          </p>
        );
      case 'heading':
        return createElement(`h${block.attrs.level}`, { key: index }, inline(block.content));
      case 'blockquote':
        return <blockquote key={index}>{blocks(block.content)}</blockquote>;
      case 'codeBlock':
        return (
          <pre key={index}>
            <code>{block.content?.map((part) => part.text).join('')}</code>
          </pre>
        );
      case 'bulletList':
        return (
          <ul key={index}>
            {block.content.map((item, position) => (
              <li key={position}>{blocks(item.content)}</li>
            ))}
          </ul>
        );
      case 'orderedList':
        return (
          <ol key={index} start={block.attrs.start}>
            {block.content.map((item, position) => (
              <li key={position}>{blocks(item.content)}</li>
            ))}
          </ol>
        );
      case 'taskList':
        return (
          <ul key={index} data-type="taskList">
            {block.content.map((item, position) => (
              <li key={position} data-type="taskItem" data-checked={String(item.attrs.checked)}>
                <span className="rio-rich-text__check">
                  <input type="checkbox" checked={item.attrs.checked} disabled readOnly />
                </span>
                <div className="rio-rich-text__task">{blocks(item.content)}</div>
              </li>
            ))}
          </ul>
        );
    }
  });
}

/** Matching document and toolbar geometry keeps surrounding fields still while the editor loads. */
export function RichTextPreview({
  value,
  className,
  editor = false,
  literal = false,
}: {
  value: string;
  className?: string;
  editor?: boolean;
  literal?: boolean;
}) {
  const { t } = useLingui();
  const headings = [
    t({ id: 'fields.richText.heading1.short', message: 'H1' }),
    t({ id: 'fields.richText.heading2.short', message: 'H2' }),
    t({ id: 'fields.richText.heading3.short', message: 'H3' }),
  ];
  const document = (
    <div className="rio-rich-text__content">
      {literal ? (
        <p>
          {value.split('\n').map((line, index) => (
            <Fragment key={index}>
              {index > 0 && <br />}
              {line}
            </Fragment>
          ))}
          {!value || value.endsWith('\n') ? <br /> : null}
        </p>
      ) : (
        blocks(markdownToDoc(value).content)
      )}
    </div>
  );
  return (
    <div className="rio-rich-text-preview" aria-busy="true">
      <div aria-hidden="true" inert>
        {editor ? (
          <div className="rio-rich-text">
            <div className="rio-rich-text__frame">
              <div className="rio-rich-text__tools">
                <Toolbar density="compact" className="rio-rich-text__toolbar">
                  {[5, 3, 3, 2].map((count, group) => (
                    <Fragment key={group}>
                      {group > 0 && <Separator orientation="vertical" />}
                      {Array.from({ length: count }, (_, tool) => (
                        <span key={tool} className="rio-rich-text__tool">
                          {group === 1 ? (
                            <span className="rio-rich-text__tool-text">{headings[tool]}</span>
                          ) : (
                            <span className="rio-rich-text-preview__icon" />
                          )}
                        </span>
                      ))}
                    </Fragment>
                  ))}
                </Toolbar>
              </div>
              <div className="rio-rich-text__body">{document}</div>
            </div>
            <div className="rio-field-input__error" />
          </div>
        ) : (
          <div className={cx('rio-rich-text-view', className)}>{document}</div>
        )}
      </div>
      <div className="rio-rich-text-preview__status">
        <LoadingState size="controls" />
      </div>
    </div>
  );
}
