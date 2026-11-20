function riosomaSegment(value, record) {
  var text = typeof value === 'string' ? value : '';
  if (record) text = text.replace(/:\d+$/, '');
  if (!/^[A-Za-z0-9_-]+$/.test(text)) throw new Error(iml.riosomaMessage('error.input'));
  return text;
}
