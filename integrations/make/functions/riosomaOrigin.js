function riosomaOrigin(value) {
  var text = typeof value === 'string' ? value.trim() : '';
  var match = /^https:\/\/([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?|\[[0-9a-f:]+\])(?::([0-9]{1,5}))?\/?$/i.exec(
    text,
  );
  if (!match || (match[2] && (+match[2] < 1 || +match[2] > 65535))) {
    throw new Error(iml.riosomaMessage('error.address'));
  }
  return text.replace(/\/$/, '');
}
