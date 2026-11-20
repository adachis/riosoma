import { Trans } from '@lingui/react/macro';

/** Shown until a view type's own component exists. */
export function ViewPlaceholder() {
  return (
    <div className="rio-view-placeholder">
      <Trans id="views.placeholder">This kind of view is on its way.</Trans>
    </div>
  );
}
