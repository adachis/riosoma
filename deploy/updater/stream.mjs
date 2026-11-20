/** A command's output from an exec, taking the stream apart when Docker multiplexed it */
export function demultiplex(buffer) {
  if (buffer.length < 8 || buffer[0] > 2 || buffer[1] || buffer[2] || buffer[3])
    return buffer.toString('utf8');
  const decoder = new TextDecoder();
  let output = '';
  let offset = 0;
  while (offset + 8 <= buffer.length) {
    const size = buffer.readUInt32BE(offset + 4);
    output += decoder.decode(buffer.subarray(offset + 8, offset + 8 + size), { stream: true });
    offset += 8 + size;
  }
  return output + decoder.decode();
}
