function riosomaRecord(body, payload) {
  var record = body && body.records && body.records[0];
  // Instant triggers allow one enrichment request, so an empty read produces no record value.
  if (!record) return undefined;
  if (!payload) return record;
  return {
    id: payload.event === 'record.updated' ? record.id + ':' + payload.seq : record.id,
    recordId: record.id,
    createdTime: record.createdTime,
    fields: record.fields,
  };
}
