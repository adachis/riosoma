import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

const bootstrap = `
(() => {
  const evaluate = eval
  // WebRTC bypasses connect-src, including TURN credentials and STUN traffic.
  // Remove its entry points before any custom HTML, script, or reader data arrives.
  // Opaque descendant origins prevent borrowing fresh constructors.  Only this
  // bootstrap may run as a script element, including in srcdoc and blob documents
  // that inherit the policy, so every executable realm must harden itself first.
  // If hardening fails, stop before announcing or installing the data bridge.
  for (let target = window; target; target = Object.getPrototypeOf(target)) {
    for (const name of Object.getOwnPropertyNames(target)) {
      if (/^(?:RTC|webkitRTC|mozRTC)/.test(name)) {
        Object.defineProperty(target, name, {
          value: undefined, writable: false, configurable: false
        })
      }
    }
  }
  let initialized = false
  let sequence = 0
  let channel
  const pending = new Map()
  const post = parent.postMessage.bind(parent)
  const call = (request) => new Promise((resolve, reject) => {
    if (pending.size >= 16) return reject(new Error('interfaces.code.busy'))
    const id = ++sequence
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error('interfaces.code.timeout'))
    }, 120000)
    pending.set(id, { resolve, reject, timer })
    post({ type: 'interface-code-call', channel, id, request }, '*')
  })
  addEventListener('message', (event) => {
    if (event.source !== parent) return
    const message = event.data
    if (!message || typeof message !== 'object') return
    if (message.type === 'interface-code-result' && message.channel === channel) {
      const waiting = pending.get(message.id)
      if (!waiting) return
      pending.delete(message.id)
      clearTimeout(waiting.timer)
      if (message.error) waiting.reject(new Error(message.error))
      else waiting.resolve(message.value)
      return
    }
    if (initialized || message.type !== 'interface-code-init') return
    initialized = true
    channel = message.channel
    Object.defineProperty(window, 'rio', { value: Object.freeze({
      records: (blockId, offset = 0) => call({ method: 'records', blockId, offset }),
      selected: (blockId) => call({ method: 'selected', blockId }),
      open: (blockId, recordId) => call({ method: 'open', blockId, recordId }),
      change: (blockId, recordId, values) => call({ method: 'change', blockId, recordId, values })
    }) })
    document.documentElement.lang = message.locale
    const style = document.createElement('style')
    style.textContent = message.code.css
    document.head.append(style)
    document.body.innerHTML = message.code.html
    // Global evaluation preserves script semantics after this realm is hardened.
    evaluate(message.code.javascript)
  })
  post({ type: 'interface-code-ready' }, '*')
})()
`;

/** Only the bootstrap can start a script, so custom source always runs after hardening */
export const CODE_FRAME_POLICY = [
  "default-src 'none'",
  `script-src 'sha256-${createHash('sha256').update(bootstrap).digest('base64')}' 'unsafe-eval'`,
  "style-src 'unsafe-inline'",
  "connect-src 'none'",
  'img-src data:',
  "font-src 'none'",
  "media-src 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'self'",
  'sandbox allow-scripts',
].join('; ');

// This document contains no user data or credentials, even when opened outside the application.
export const CODE_FRAME_DOCUMENT = `<!doctype html><html><head><meta charset="utf-8"></head><body><script>${bootstrap}</script></body></html>`;

export async function codeFrameRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/interfaces/code-frame',
    {
      config: { policy: { kind: 'public' } },
      onSend: async (_request, reply) => {
        reply.header('content-security-policy', CODE_FRAME_POLICY);
        reply.header('cache-control', 'no-store');
        reply.header('referrer-policy', 'no-referrer');
        reply.header('permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
        reply.removeHeader('set-cookie');
      },
    },
    async (_request, reply) => reply.type('text/html').send(CODE_FRAME_DOCUMENT),
  );
}
