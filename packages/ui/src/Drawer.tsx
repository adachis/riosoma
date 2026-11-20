import { Modal, type ModalProps } from './Modal';
import { cx } from './cx';
import './Drawer.css';

/** A sheet is a modal minus the two choices that don't apply to it: where it sits and how wide. */
export type DrawerProps = Omit<ModalProps, 'variant' | 'size'>;

/**
 * A `Modal` that slides in from the inline end instead of the middle of the viewport.  Its inline
 * size comes from `--rio-dock-width` and it spans the full block size, so it reads as a panel of
 * the app: the place settings and details go when there is no room for a permanent sidebar.
 *
 * Put a `Dialog` inside, exactly as with `Modal`, so the sheet is exposed as one dialog.
 */
export function Drawer({ className, ...rest }: DrawerProps) {
  return <Modal {...rest} variant="drawer" className={cx('rio-drawer', className)} />;
}
