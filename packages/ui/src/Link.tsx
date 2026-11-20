import { Link as AriaLink, type LinkProps as AriaLinkProps } from 'react-aria-components';
import { useLingui } from '@lingui/react/macro';
import { faUpRightFromSquare } from '@fortawesome/free-solid-svg-icons';
import { Icon, type IconDefinition } from '@riosoma/icons';
import { cx } from './cx';
import './Link.css';

export interface LinkProps extends Omit<AriaLinkProps, 'className' | 'children'> {
  /** Opens the destination in a new tab, marked with an arrow and named as such for screen readers. */
  external?: boolean;
  /** Leading icon; decorative, since the link's label names it. */
  icon?: IconDefinition;
  className?: string;
  children?: React.ReactNode;
}

/** Keeps whatever relationship the caller asked for and adds the two a new tab needs. */
function safeRel(rel: string | undefined): string {
  const tokens = new Set(rel?.split(/\s+/).filter(Boolean));
  tokens.add('noopener');
  tokens.add('noreferrer');
  return [...tokens].join(' ');
}

/**
 * A link, in the theme's link color.  `external` is also implied by `target="_blank"`, so a link
 * that leaves the page can never quietly lose the arrow or the safe `rel`.
 */
export function Link({ external = false, icon, className, children, target, rel, ...props }: LinkProps) {
  const { t } = useLingui();
  const leavesPage = external || target === '_blank';
  return (
    <AriaLink
      {...props}
      target={leavesPage ? '_blank' : target}
      rel={leavesPage ? safeRel(rel) : rel}
      className={cx('rio-link', className)}
    >
      {icon ? <Icon icon={icon} className="rio-link__icon" /> : null}
      {children}
      {leavesPage ? (
        <Icon
          icon={faUpRightFromSquare}
          size="0.85em"
          className="rio-link__external"
          label={t({ id: 'ui.link.opensInNewTab', message: 'Opens in a new tab' })}
        />
      ) : null}
    </AriaLink>
  );
}
