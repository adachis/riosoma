import { AppError, decodeWhere, type ViewMeta } from '@riosoma/contracts';

/**
 * A view as one read sees it once a `where` token narrows it, such as a link to the records behind
 * a dashboard chart.  Nothing is saved: the token's filter joins the view's own for this read only,
 * so every part of the read that follows the view's filter (rows, positions, searches, color
 * ranges, exports, and the summary row) follows the token too.  The filter compiles with the fields the
 * reader can see, like the view's own, so a condition on any other field is left out.
 */
export function narrowView(view: ViewMeta, token: string | undefined): ViewMeta {
  if (token === undefined) return view;
  const where = decodeWhere(token);
  if (!where) throw new AppError('validation_failed', 'errors.validationFailed');
  const own = view.config.filter;
  return {
    ...view,
    config: { ...view.config, filter: own ? { conjunction: 'and', conditions: [own, where] } : where },
  };
}
