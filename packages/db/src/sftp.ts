import { createHash, timingSafeEqual } from 'node:crypto';
import ssh2, { type SFTPWrapper, type Stats } from 'ssh2';

const { Client, utils } = ssh2;

export interface SftpOptions {
  address: string;
  port: number;
  user: string;
  hostKey: string;
  password?: string;
  privateKey?: string;
  passphrase?: string;
  signal: AbortSignal;
  timeoutMs: number;
}

/** The caller supplies a checked address so SSH never resolves the host a second time */
export async function openSftp(options: SftpOptions) {
  const key = utils.parseKey(options.hostKey);
  if (key instanceof Error || key.isPrivateKey()) throw new Error('sources.remote.hostKey');
  const hash = (value: Buffer) => createHash('sha256').update(value).digest();
  const expected = hash(key.getPublicSSH());
  const client = new Client();
  const stop = () => client.destroy();
  options.signal.throwIfAborted();
  options.signal.addEventListener('abort', stop, { once: true });
  let mismatch = false;
  try {
    await new Promise<void>((resolve, reject) => {
      client.once('ready', resolve);
      client.on('error', (error: Error) => reject(mismatch ? new Error('sources.remote.hostKey') : error));
      client.once('close', () => reject(new Error('sources.test.connect')));
      client.connect({
        host: options.address,
        port: options.port,
        username: options.user,
        password: options.password,
        privateKey: options.privateKey,
        passphrase: options.passphrase,
        readyTimeout: options.timeoutMs,
        hostVerifier: (actual: Buffer) => {
          mismatch = !timingSafeEqual(expected, hash(actual));
          return !mismatch;
        },
      });
    });
    const sftp = await new Promise<SFTPWrapper>((resolve, reject) => {
      const closed = () => finish(new Error('sources.test.connect'));
      const timer = setTimeout(() => finish(new Error('sources.test.timeout')), options.timeoutMs);
      const finish = (error?: Error, channel?: SFTPWrapper) => {
        clearTimeout(timer);
        client.removeListener('close', closed);
        if (error) reject(error);
        else resolve(channel!);
      };
      client.once('close', closed);
      client.sftp(finish);
    });
    const call = <T>(run: (done: (error: Error | undefined, value: T) => void) => void) =>
      new Promise<T>((resolve, reject) => {
        const abort = () => finish(new Error('sources.test.timeout'));
        const closed = () => finish(new Error('sources.test.connect'));
        const timer = setTimeout(abort, options.timeoutMs);
        const finish = (error?: Error, value?: T) => {
          clearTimeout(timer);
          options.signal.removeEventListener('abort', abort);
          client.removeListener('close', closed);
          if (error) reject(error);
          else resolve(value as T);
        };
        options.signal.addEventListener('abort', abort, { once: true });
        client.once('close', closed);
        if (options.signal.aborted) abort();
        else run(finish);
      });
    return {
      stat: (path: string) => call<Stats>((done) => sftp.stat(path, done)),
      async list(path: string) {
        const handle = await call<Buffer>((done) => sftp.opendir(path, done));
        const entries: Array<{ filename: string; attrs: Stats }> = [];
        try {
          for (;;) {
            const batch = await call<Array<{ filename: string; attrs: Stats }> | false>((done) =>
              sftp.readdir(handle, (error, batch) => {
                if (error && 'code' in error && error.code === 1) done(undefined, false);
                else done(error, batch);
              }),
            );
            if (!batch || !batch.length) return entries;
            entries.push(...batch);
            if (entries.length > 5_000) throw new Error('sources.file.tooManyFiles');
          }
        } finally {
          await call<void>((done) => sftp.close(handle, (error) => done(error ?? undefined, undefined)));
        }
      },
      read(path: string) {
        const stream = sftp.createReadStream(path);
        let timer = setTimeout(() => stream.destroy(new Error('sources.test.timeout')), options.timeoutMs);
        stream.on('readable', () => {
          clearTimeout(timer);
          timer = setTimeout(() => stream.destroy(new Error('sources.test.timeout')), options.timeoutMs);
        });
        stream.once('close', () => clearTimeout(timer));
        return stream;
      },
      close() {
        options.signal.removeEventListener('abort', stop);
        client.destroy();
      },
    };
  } catch (error) {
    options.signal.removeEventListener('abort', stop);
    client.destroy();
    throw error;
  }
}
