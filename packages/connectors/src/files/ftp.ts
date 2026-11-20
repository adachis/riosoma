import { createConnection, isIP, type Socket } from 'node:net';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import { ConnectorError } from '../types.js';

export interface FtpEntry {
  name: string;
  bytes: number | null;
  modified: string | null;
  directory: boolean;
}

/** MLSD supplies UTC timestamps without the locale ambiguity of LIST */
export function parseFtpListing(text: string, machine: boolean): FtpEntry[] {
  const entries: FtpEntry[] = [];
  for (const line of text.split(/\r?\n/).filter(Boolean)) {
    if (machine) {
      const match = /^((?:[^=; ]+=[^;]*;)+) (.+)$/.exec(line);
      if (!match) throw new ConnectorError('sources.remote.listing');
      const facts = Object.fromEntries(
        match[1]!
          .split(';')
          .filter(Boolean)
          .map((fact) => {
            const at = fact.indexOf('=');
            return [fact.slice(0, at).toLowerCase(), fact.slice(at + 1)];
          }),
      );
      if (facts.type === 'cdir' || facts.type === 'pdir') continue;
      if (facts.type !== 'file' && facts.type !== 'dir') continue;
      const date = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\.(\d+))?$/.exec(facts.modify ?? '');
      const modified = date
        ? `${date[1]}-${date[2]}-${date[3]}T${date[4]}:${date[5]}:${date[6]}${date[7] ? `.${date[7]}` : ''}Z`
        : null;
      entries.push({
        name: match[2]!,
        bytes: facts.size === undefined ? null : Number(facts.size),
        modified,
        directory: facts.type === 'dir',
      });
    } else {
      if (/^total \d+$/.test(line)) continue;
      const match =
        /^([d-])[rwxStTs-]{9}\s+\d+\s+\S+\s+\S+\s+(\d+)\s+(\w{3})\s+(\d{1,2})\s+(\d{4}|\d{2}:\d{2})\s+(.+)$/.exec(
          line,
        );
      if (!match) {
        if (line.startsWith('l')) continue;
        throw new ConnectorError('sources.remote.listing');
      }
      // LIST has no timezone and often no year, so it cannot safely supply a change validator
      entries.push({ name: match[6]!, bytes: Number(match[2]), modified: null, directory: match[1] === 'd' });
    }
  }
  if (
    entries.some((entry) => entry.bytes !== null && (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0))
  )
    throw new ConnectorError('sources.remote.listing');
  return entries;
}

interface Reply {
  code: number;
  text: string;
}

/** Only passive downloads are supported, and data sockets always use the checked control address */
export async function openFtp(options: {
  address: string;
  host: string;
  port: number;
  user: string;
  password: string;
  secure: boolean;
  signal: AbortSignal;
  timeoutMs: number;
}) {
  let socket: Socket | TLSSocket = createConnection({ host: options.address, port: options.port });
  const sockets = new Set<Socket>([socket]);
  const queue: Reply[] = [];
  let waiting: { resolve(reply: Reply): void; reject(error: Error): void } | undefined;
  let buffer = '';
  let multiline: { code: number; lines: string[] } | undefined;
  let failed: Error | undefined;
  const close = () => {
    options.signal.removeEventListener('abort', aborted);
    for (const connection of sockets) connection.destroy();
  };
  const fail = (error: Error) => {
    failed ??= error;
    waiting?.reject(error);
    waiting = undefined;
    close();
  };
  const aborted = () => fail(new ConnectorError('sources.test.timeout'));
  const receive = (data: Buffer) => {
    buffer += data.toString('utf8');
    if (buffer.length > 64_000) return fail(new ConnectorError('sources.remote.listing'));
    for (;;) {
      const end = buffer.indexOf('\r\n');
      if (end < 0) break;
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      if (multiline) {
        multiline.lines.push(line);
        if (multiline.lines.join('').length > 64_000)
          return fail(new ConnectorError('sources.remote.listing'));
        if (!line.startsWith(`${multiline.code} `)) continue;
      } else {
        const match = /^(\d{3})([ -])/.exec(line);
        if (!match) return fail(new ConnectorError('sources.remote.listing'));
        multiline = { code: Number(match[1]), lines: [line] };
        if (match[2] === '-') continue;
      }
      const reply = { code: multiline.code, text: multiline.lines.join('\n') };
      multiline = undefined;
      if (waiting) {
        const pending = waiting;
        waiting = undefined;
        pending.resolve(reply);
      } else queue.push(reply);
      if (queue.length > 10) return fail(new ConnectorError('sources.remote.listing'));
    }
  };
  const watch = (connection: Socket) => {
    sockets.add(connection);
    connection.setTimeout(options.timeoutMs, () => fail(new ConnectorError('sources.test.timeout')));
    connection.on('error', fail);
  };
  watch(socket);
  socket.on('data', receive);
  socket.on('close', () => fail(new ConnectorError('sources.test.connect')));
  const reply = () =>
    new Promise<Reply>((resolve, reject) => {
      if (failed) reject(failed);
      else if (queue.length) resolve(queue.shift()!);
      else waiting = { resolve, reject };
    });
  const command = (text: string) => {
    if (/[\r\n\0]/.test(text)) throw new ConnectorError('sources.remote.path');
    const pending = reply();
    socket.write(`${text}\r\n`);
    return pending;
  };
  const expect = (answer: Reply, codes: number[]) => {
    if (!codes.includes(answer.code))
      throw new ConnectorError(
        answer.code === 530 ? 'sources.test.authenticate' : 'sources.remote.reply',
        undefined,
        { status: answer.code },
      );
    return answer;
  };
  options.signal.addEventListener('abort', aborted, { once: true });
  try {
    options.signal.throwIfAborted();
    expect(await reply(), [220]);
    if (options.secure) {
      expect(await command('AUTH TLS'), [234]);
      socket.removeListener('data', receive);
      socket.setTimeout(0);
      const secured = tlsConnect({
        socket,
        host: options.host,
        ...(isIP(options.host) ? {} : { servername: options.host }),
        rejectUnauthorized: true,
      });
      watch(secured);
      await new Promise<void>((resolve, reject) => {
        secured.once('secureConnect', resolve);
        secured.once('error', reject);
        secured.once('close', () => reject(new ConnectorError('sources.test.tls')));
      });
      socket = secured;
      socket.on('data', receive);
      socket.on('close', () => fail(new ConnectorError('sources.test.connect')));
    }
    const user = expect(await command(`USER ${options.user}`), [230, 331]);
    if (user.code === 331) expect(await command(`PASS ${options.password}`), [230]);
    if (options.secure) {
      expect(await command('PBSZ 0'), [200]);
      expect(await command('PROT P'), [200]);
    }
    expect(await command('TYPE I'), [200]);
    const transfer = async (text: string) => {
      const extended = await command('EPSV');
      let port: number;
      if (extended.code === 229) {
        const match = /\(\|\|\|(\d+)\|\)/.exec(extended.text);
        port = Number(match?.[1]);
      } else {
        expect(extended, [500, 501, 502, 504, 522]);
        const passive = expect(await command('PASV'), [227]);
        const parts = /\((\d+),(\d+),(\d+),(\d+),(\d+),(\d+)\)/.exec(passive.text);
        if (!parts || parts.slice(1).some((part) => Number(part) > 255))
          throw new ConnectorError('sources.remote.passive');
        port = Number(parts[5]) * 256 + Number(parts[6]);
      }
      if (!Number.isInteger(port) || port < 1 || port > 65_535)
        throw new ConnectorError('sources.remote.passive');
      let data: Socket = createConnection({ host: options.address, port });
      watch(data);
      await new Promise<void>((resolve, reject) => {
        data.once('connect', resolve);
        data.once('error', reject);
        data.once('close', () => reject(new ConnectorError('sources.test.connect')));
      });
      try {
        expect(await command(text), [125, 150]);
        socket.setTimeout(0);
        if (options.secure) {
          data.setTimeout(0);
          const secure = tlsConnect({
            socket: data,
            host: options.host,
            ...(isIP(options.host) ? {} : { servername: options.host }),
            rejectUnauthorized: true,
            session: (socket as TLSSocket).getSession(),
          });
          watch(secure);
          data = secure;
          await new Promise<void>((resolve, reject) => {
            secure.once('secureConnect', resolve);
            secure.once('error', reject);
            secure.once('close', () => reject(new ConnectorError('sources.test.tls')));
          });
        }
        return (async function* () {
          try {
            for await (const chunk of data) yield chunk as Buffer;
            socket.setTimeout(options.timeoutMs);
            expect(await reply(), [226, 250]);
          } finally {
            data.destroy();
            sockets.delete(data);
          }
        })();
      } catch (error) {
        data.destroy();
        throw error;
      }
    };
    return {
      async list(path: string) {
        let machine = true;
        let body: AsyncIterable<Buffer>;
        try {
          body = await transfer(`MLSD ${path}`);
        } catch (error) {
          if (
            !(error instanceof ConnectorError) ||
            ![500, 501, 502, 504].includes(Number(error.params?.status))
          )
            throw error;
          machine = false;
          body = await transfer(`LIST ${path}`);
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        for await (const chunk of body) {
          bytes += chunk.length;
          if (bytes > 4 * 1024 * 1024) throw new ConnectorError('sources.file.tooManyFiles');
          chunks.push(chunk);
        }
        return parseFtpListing(Buffer.concat(chunks).toString('utf8'), machine);
      },
      read: (path: string) => transfer(`RETR ${path}`),
      close,
    };
  } catch (error) {
    close();
    throw error;
  }
}
