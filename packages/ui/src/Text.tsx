import { Text as AriaText, type TextProps as AriaTextProps } from 'react-aria-components';
import { cx } from './cx';
import './Text.css';

/** body: running text.  muted: secondary.  small: fine print.  mono: identifiers and queries. */
export type TextVariant = 'body' | 'muted' | 'small' | 'mono';

export interface TextProps extends Omit<AriaTextProps, 'className'> {
  variant?: TextVariant;
  className?: string;
}

/**
 * A run of text on the shared type scale.  It stays a `span` unless the caller asks for another
 * element, so it can sit inside a paragraph, a table cell, or a field (with `slot`) alike.
 */
export function Text({ variant = 'body', className, ...props }: TextProps) {
  return <AriaText {...props} data-variant={variant} className={cx('rio-text', className)} />;
}
