function riosomaCursor(cursor, seen) {
  var result = (seen || []).slice();
  if (!cursor) return result;
  if (typeof cursor !== 'string' || result.indexOf(cursor) !== -1)
    throw new Error(iml.riosomaMessage('error.cursor'));
  result.push(cursor);
  return result;
}
