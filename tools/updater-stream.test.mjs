import assert from 'node:assert/strict';
import { test } from 'node:test';
import { demultiplex } from '../deploy/updater/stream.mjs';

test('command output preserves UTF-8 split across multiplexed frames', () => {
  const text = 'café 漢字 😀';
  const frames = [...Buffer.from(text)].map((byte) => {
    const header = Buffer.alloc(8);
    header[0] = 1;
    header.writeUInt32BE(1, 4);
    return Buffer.concat([header, Buffer.from([byte])]);
  });
  assert.equal(demultiplex(Buffer.concat(frames)), text);
  assert.equal(demultiplex(Buffer.from(text)), text);
});

test('command output flushes an incomplete final UTF-8 sequence', () => {
  const frame = Buffer.alloc(9);
  frame[0] = 1;
  frame.writeUInt32BE(1, 4);
  frame[8] = 0xc3;
  assert.equal(demultiplex(frame), '\ufffd');
});
