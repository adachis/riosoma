function riosomaFilter(table, id, value) {
  var field = table.fields.find(function (entry) {
    return entry.id === id;
  });
  var numbers = ['number', 'currency', 'percent', 'duration', 'rating'];
  var text = ['text', 'longText', 'url', 'email', 'phone', 'barcode'];
  var operator = 'is';
  if (!field) throw new Error(iml.riosomaMessage('error.input'));
  if (numbers.indexOf(field.type) !== -1) {
    if (typeof value === 'string' && value.trim()) value = Number(value);
    if (typeof value !== 'number' || !Number.isFinite(value))
      throw new Error(iml.riosomaMessage('error.input'));
    operator = 'eq';
  } else if (field.type === 'checkbox') {
    if (value === 'true') value = true;
    if (value === 'false') value = false;
    if (typeof value !== 'boolean') throw new Error(iml.riosomaMessage('error.input'));
  } else if (text.indexOf(field.type) === -1 || typeof value !== 'string' || !value.length) {
    throw new Error(iml.riosomaMessage('error.input'));
  }
  return JSON.stringify({
    conjunction: 'and',
    conditions: [{ id: 'match', fieldId: field.id, operator: operator, value: value }],
  });
}
