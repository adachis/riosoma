import { Heading as AriaHeading, type HeadingProps as AriaHeadingProps } from 'react-aria-components';
import { cx } from './cx';
import './Heading.css';

/** The four levels the type scale defines; screens never go deeper than that. */
export type HeadingLevel = 1 | 2 | 3 | 4;

export interface HeadingProps extends Omit<AriaHeadingProps, 'className' | 'level'> {
  level?: HeadingLevel;
  className?: string;
}

/**
 * A section title on the shared type scale.  Levels 1 and 2 carry the theme's display face, since
 * they head a screen or a large section; 3 and 4 stay in the body face so nested headings do not
 * shout over the content they introduce.
 */
export function Heading({ level = 2, className, ...props }: HeadingProps) {
  return <AriaHeading level={level} {...props} className={cx('rio-heading', className)} />;
}
