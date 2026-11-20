function riosomaFields(table, search) {
  var computed = [
    'changeLog',
    'createdTime',
    'lastModifiedTime',
    'createdBy',
    'lastModifiedBy',
    'recordId',
    'lookup',
    'rollup',
    'count',
    'formula',
    'autoNumber',
    'button',
  ];
  var numbers = ['number', 'currency', 'percent', 'duration', 'rating'];
  var text = ['text', 'longText', 'url', 'email', 'phone', 'barcode'];
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
  return table.fields
    .filter(function (field) {
      return search
        ? text.indexOf(field.type) !== -1 || numbers.indexOf(field.type) !== -1 || field.type === 'checkbox'
        : computed.indexOf(field.type) === -1;
    })
    .map(function (field) {
      if (search) return { label: field.name, value: field.id };
      var type =
        numbers.indexOf(field.type) !== -1
          ? 'number'
          : ['date', 'email', 'url'].indexOf(field.type) !== -1
            ? field.type
            : 'text';
      var input = { name: field.id, label: field.name, type: type, required: false };
      if (field.type === 'singleSelect') {
        input.type = 'select';
        input.options = ((field.options && field.options.choices) || []).map(function (choice) {
          return { label: choice.name, value: choice.name };
        });
      }
      if (field.type === 'checkbox') {
        // An optional select leaves an untouched checkbox out of a partial update.
        input.type = 'select';
        input.options = [
          { label: iml.riosomaMessage('field.true'), value: true },
          { label: iml.riosomaMessage('field.false'), value: false },
        ];
      }
      if (structured.indexOf(field.type) !== -1) input.help = iml.riosomaMessage('field.json');
      if (field.type === 'longText' || structured.indexOf(field.type) !== -1) input.multiline = true;
      return input;
    });
}
