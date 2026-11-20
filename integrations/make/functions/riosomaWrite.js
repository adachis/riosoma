function riosomaWrite(parameters, table, update) {
  var fields = {};
  var supplied = parameters.fields || {};
  var numbers = ['number', 'currency', 'percent', 'duration', 'rating'];
  var structured = [
    'attachment',
    'link',
    'user',
    'multipleSelect',
    'json',
    'dateRange',
    'location',
    'signature',
    'multiCurrency',
  ];
  var writable = iml.riosomaFields(table, false).map(function (field) {
    return field.name;
  });
  table.fields.forEach(function (field) {
    if (
      writable.indexOf(field.id) === -1 ||
      !Object.prototype.hasOwnProperty.call(supplied, field.id) ||
      supplied[field.id] === undefined ||
      supplied[field.id] === null
    )
      return;
    var value = supplied[field.id];
    if (field.type === 'date' && Object.prototype.toString.call(value) === '[object Date]') {
      if (!Number.isFinite(value.getTime())) throw new Error(iml.riosomaMessage('error.input'));
      value = value.toISOString();
    }
    if (structured.indexOf(field.type) !== -1 && typeof value === 'string')
      value = iml.riosomaApi('json', value);
    if (numbers.indexOf(field.type) !== -1 && typeof value === 'string' && value.trim())
      value = Number(value);
    if (numbers.indexOf(field.type) !== -1 && (typeof value !== 'number' || !Number.isFinite(value)))
      throw new Error(iml.riosomaMessage('error.input'));
    if (field.type === 'checkbox') {
      if (value === 'true') value = true;
      if (value === 'false') value = false;
      if (typeof value !== 'boolean') throw new Error(iml.riosomaMessage('error.input'));
    }
    fields[field.id] = value;
  });
  if (!Object.keys(fields).length) throw new Error(iml.riosomaMessage('error.input'));
  var record = { fields: fields };
  if (update) record.id = iml.riosomaSegment(parameters.record, true);
  return { fieldKey: 'id', records: [record] };
}
