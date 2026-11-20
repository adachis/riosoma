function riosomaEvents(body, parameters, eventType) {
  if (
    !body ||
    typeof body.id !== 'string' ||
    !Array.isArray(body.events) ||
    body.events.length > 100 ||
    body.databaseId !== parameters.database
  )
    return [];
  return body.events
    .filter(function (event) {
      return (
        event.event === eventType &&
        event.databaseId === parameters.database &&
        event.tableId === parameters.table &&
        typeof event.recordId === 'string' &&
        /^rec[A-Za-z0-9]{14}$/.test(event.recordId) &&
        Number.isSafeInteger(event.seq)
      );
    })
    .sort(function (left, right) {
      return left.seq - right.seq;
    })
    .map(function (event) {
      return {
        recordId: event.recordId,
        table: event.tableId,
        database: event.databaseId,
        seq: event.seq,
        event: event.event,
        view: parameters.view,
        deliveryId: body.id,
      };
    });
}
