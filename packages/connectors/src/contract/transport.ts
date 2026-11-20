import { inspect } from 'node:util';
import type { ConnectorContext } from '../types.js';

const TRANSPORT =
  /^(fetch|request|resolve|handshake|check|query|execute|executeStatement|createQueryJob|prepare|run|runAndReadAll|streamAndReadAll|connectAsync|connect|send|find|aggregate|getMetadata|listCollections|listDatabases|list|select|dryRun|authenticate|datasets|tables|table|openInstance|client)$/;

/** Captures driver calls and injects stalled or failed transports for contract probes */
export class ContractTransport {
  readonly requests: string[] = [];
  mode: 'normal' | 'failure' | 'slow' = 'normal';
  context?: ConnectorContext;
  stopped = false;
  private pending = new Set<() => void>();
  private wrapped = new WeakMap<object, object>();

  reset(): void {
    this.mode = 'normal';
    for (const stop of this.pending) stop();
    this.pending.clear();
  }

  wrap<T>(value: T, name = ''): T {
    if (!value || (typeof value !== 'object' && typeof value !== 'function')) return value;
    if (
      value instanceof Date ||
      value instanceof Buffer ||
      value instanceof Response ||
      value instanceof URL ||
      value instanceof AbortSignal
    )
      return value;
    const object = value as object;
    const cached = this.wrapped.get(object);
    if (cached) return cached as T;
    const wrapResult = (result: unknown): unknown =>
      result instanceof Promise ? result.then((result) => this.wrap(result)) : this.wrap(result);
    const proxy = new Proxy(object, {
      get: (target, key) => {
        const member = Reflect.get(target, key, target);
        if (key === 'constructor') return member;
        if (typeof member !== 'function') return this.wrap(member, String(key));
        return (...args: unknown[]) => {
          const method = String(key);
          if (/close|cancel|abort|destroy|kill|end$|detach|disconnect/i.test(method)) {
            this.stopped = true;
            for (const stop of this.pending) stop();
          }
          const transport = TRANSPORT.test(method);
          if (transport)
            return this.call(method, args, () => Reflect.apply(member, target, args), wrapResult);
          return wrapResult(Reflect.apply(member, target, args));
        };
      },
      apply: (target, thisArg, args) => {
        return this.call(
          name,
          args,
          () => Reflect.apply(target as (...args: unknown[]) => unknown, thisArg, args),
          wrapResult,
        );
      },
      construct: (target, args) => {
        return this.wrap(Reflect.construct(target as new (...args: unknown[]) => object, args)) as object;
      },
    });
    this.wrapped.set(object, proxy);
    return proxy as T;
  }

  private call(name: string, args: unknown[], action: () => unknown, wrap: (result: unknown) => unknown) {
    const transport = TRANSPORT.test(name);
    if (!transport) return wrap(action());
    this.requests.push(inspect(args, { depth: 12, breakLength: Infinity }));
    if (this.mode === 'failure') {
      const secrets = Object.values(this.context?.secrets ?? {}).join(' ');
      throw new Error(`transport refused ${secrets}`);
    }
    if (this.mode !== 'slow') return wrap(action());
    if (name === 'send') return true;
    return new Promise((resolve, reject) => {
      const signal = args
        .flatMap((arg) =>
          arg instanceof AbortSignal
            ? [arg]
            : arg && typeof arg === 'object' && 'signal' in arg
              ? [(arg as { signal?: AbortSignal }).signal]
              : [],
        )
        .find((signal) => signal instanceof AbortSignal);
      const stop = () => {
        this.stopped = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', stop);
        this.pending.delete(stop);
        reject(new Error('transport stopped'));
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', stop);
        this.pending.delete(stop);
        resolve(wrap(action()));
      }, 250);
      this.pending.add(stop);
      signal?.addEventListener('abort', stop, { once: true });
    });
  }
}
