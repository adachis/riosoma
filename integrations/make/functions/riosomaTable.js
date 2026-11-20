function riosomaTable(tables, id) {
  var table = (tables || []).find(function (entry) {
    return entry.id === id;
  });
  if (!table) throw new Error(iml.riosomaMessage('error.input'));
  return table;
}
