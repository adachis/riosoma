# Sparkline scrolling and indexed first pages

Sparklines reuse numeric geometry and accessible labels across equal lists within a view.  The
cache holds at most 256 lists of at most 512 values.  Larger lists still render normally.  Geometry
includes chart type, highlights, and shared-axis bounds.  The existing 100 by 24 view box remains
unchanged, so resizing stretches the same geometry as before.  SVG markup is cached separately by
geometry and palette, with at most eight palette variants per shape.

The grid identifies visible cells and redraws cells when they enter the viewport.  Visible
sparklines draw immediately, while overscan SVGs draw during idle time.  Recycled cells replace
pending work and clear stale charts.  Disconnected nodes are discarded.  Rendering also avoids
formatting the scalar value replaced by a sparkline and constructing a list formatter for a
single accessible label.

A sorted first page counts membership without sorting it and traverses only the requested index
prefix.  An existing exact count can be reused across unfiltered views only when the table,
committed data version, and access dependencies match.  With no reusable snapshot, the count and
prefix are still read in one query.  The first page and the full retained order use the same
repeatable-read transaction.  Subsequent pages and live changes wait for that original order,
preserving cursor semantics during concurrent writes.  Groups, pins, selections, refresh requests,
and disabled snapshot caching retain the existing path.  The index advisor also avoids constructing
a duplicate of an equivalent externally maintained plain-column index.
