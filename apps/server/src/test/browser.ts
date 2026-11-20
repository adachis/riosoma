import type { FastifyInstance, LightMyRequestResponse } from 'fastify';

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

function setCookies(response: LightMyRequestResponse): string[] {
  const header = response.headers['set-cookie'];
  return Array.isArray(header) ? header : header ? [header] : [];
}

/**
 * One browser talking to the app: it keeps the cookies the server sets, drops the ones it clears,
 * and echoes the CSRF token of the session it last saw, the way the web app does.
 */
export class Browser {
  private readonly jar = new Map<string, string>();
  csrf: string | null = null;

  constructor(
    readonly app: FastifyInstance,
    readonly remoteAddress = '127.0.0.1',
  ) {}

  cookie(name: string): string | undefined {
    return this.jar.get(name);
  }

  setCookie(name: string, value: string): void {
    this.jar.set(name, value);
  }

  forget(name: string): void {
    this.jar.delete(name);
  }

  /** A second browser holding copies of this one's cookies, as a thief with a copy would. */
  copy(): Browser {
    const other = new Browser(this.app, this.remoteAddress);
    for (const [name, value] of this.jar) other.jar.set(name, value);
    other.csrf = this.csrf;
    return other;
  }

  async send(method: Method, url: string, payload?: unknown): Promise<LightMyRequestResponse> {
    const headers: Record<string, string> = {};
    if (this.jar.size) headers.cookie = [...this.jar].map(([name, value]) => `${name}=${value}`).join('; ');
    if (method !== 'GET' && this.csrf) headers['x-csrf-token'] = this.csrf;
    const response = await this.app.inject({
      method,
      url,
      headers,
      remoteAddress: this.remoteAddress,
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
    for (const header of setCookies(response)) {
      const [pair] = header.split(';');
      const at = pair!.indexOf('=');
      const name = pair!.slice(0, at);
      const value = pair!.slice(at + 1);
      if (!value || /Expires=Thu, 01 Jan 1970/i.test(header) || /Max-Age=0\b/i.test(header))
        this.jar.delete(name);
      else this.jar.set(name, value);
    }
    const type = String(response.headers['content-type'] ?? '');
    if (type.includes('application/json') && response.body) {
      const body = response.json<{ csrfToken?: unknown; session?: { csrfToken?: unknown } }>();
      const token = body?.csrfToken ?? body?.session?.csrfToken;
      if (typeof token === 'string') this.csrf = token;
    }
    return response;
  }

  get(url: string) {
    return this.send('GET', url);
  }

  post(url: string, payload?: unknown) {
    return this.send('POST', url, payload);
  }

  put(url: string, payload?: unknown) {
    return this.send('PUT', url, payload);
  }

  patch(url: string, payload?: unknown) {
    return this.send('PATCH', url, payload);
  }

  delete(url: string, payload?: unknown) {
    return this.send('DELETE', url, payload);
  }
}
