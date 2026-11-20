function riosomaApi(kind, value) {
  if (kind === 'path') {
    if (
      typeof value !== 'string' ||
      !/^\/api\/v1(?:\/[A-Za-z0-9_.~/-]*)?$/.test(value) ||
      /\/\/(?!$)|\/(?:\.|\.\.)(?:\/|$)/.test(value)
    ) {
      throw new Error(iml.riosomaMessage('error.path'));
    }
    return value;
  }
  if (kind === 'method') {
    if (['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'HEAD', 'OPTIONS'].indexOf(value) === -1) {
      throw new Error(iml.riosomaMessage('error.input'));
    }
    return value;
  }
  if (kind === 'query') {
    var result = {};
    (value || []).forEach(function (entry) {
      if (
        typeof entry.key !== 'string' ||
        !entry.key ||
        ['__proto__', 'constructor', 'prototype'].indexOf(entry.key) !== -1
      ) {
        throw new Error(iml.riosomaMessage('error.input'));
      }
      result[entry.key] = entry.value;
    });
    return result;
  }
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch (_) {
    throw new Error(iml.riosomaMessage('error.json'));
  }
}
