import {
  visibleFormQuestions,
  blockBands,
  type HeroButton,
  type InterfacePage,
  type SitePageSettings,
  type SiteSettings,
} from '@riosoma/contracts';
import { chartSvg } from './charts.js';
import { markdownHtml } from './markdown.js';
import { siteLink } from './links.js';
export { SITE_CSS } from './site.css.js';
import { decodeSiteAnswers } from './form-values.js';
import { escapeHtml, formatMessage } from '../reports/messages.js';
import { SITE_LIMITS, type SiteContent, type SiteHistoryEntry } from './reads.js';
import type { PictureSize } from './media.js';

const messages = {
  enlarge: /*i18n*/ { id: 'interfaces.media.enlarge.open', message: 'Enlarge image' },
  enlargeDescription: /*i18n*/ {
    id: 'interfaces.media.enlarge.description',
    message: 'Enlarge image: {description}',
  },
  closeImage: /*i18n*/ { id: 'interfaces.media.enlarge.close', message: 'Close image' },
  enlargeVideo: /*i18n*/ { id: 'interfaces.media.enlarge.video', message: 'Enlarge video' },
  enlargeVideoDescription: /*i18n*/ {
    id: 'interfaces.media.enlarge.videoDescription',
    message: 'Enlarge video: {description}',
  },
  closeVideo: /*i18n*/ { id: 'interfaces.media.enlarge.closeVideo', message: 'Close video' },
  amount: /*i18n*/ { id: 'fields.multiCurrency.amount', message: 'Amount' },
  currency: /*i18n*/ { id: 'field.currency.code', message: 'Currency' },
  addLine: /*i18n*/ { id: 'lineItems.add', message: 'Add line' },
  required: /*i18n*/ { id: 'form.requiredMissing', message: 'Answer this question.' },
  line: /*i18n*/ { id: 'sites.line', message: 'Line {line}' },
  lineColumn: /*i18n*/ { id: 'sites.lineColumn', message: '{name}, line {line}' },
  historyPerson: /*i18n*/ { id: 'fields.changeLog.unknownPerson', message: 'Unknown person' },
  historyEntry: /*i18n*/ { id: 'fields.changeLog.entry', message: '{at} {actor}: {fields}' },
  latitude: /*i18n*/ { id: 'sites.latitude', message: 'Latitude' },
  longitude: /*i18n*/ { id: 'sites.longitude', message: 'Longitude' },
  start: /*i18n*/ { id: 'sites.start', message: 'Start' },
  end: /*i18n*/ { id: 'sites.end', message: 'End' },
  utc: /*i18n*/ { id: 'sites.utc', message: 'Times use UTC.' },
  yes: /*i18n*/ { id: 'sites.yes', message: 'Yes' },
  no: /*i18n*/ { id: 'sites.no', message: 'No' },
  all: /*i18n*/ { id: 'sites.all', message: 'All' },
  skip: /*i18n*/ { id: 'sites.skip', message: 'Skip to content' },
  menu: /*i18n*/ { id: 'sites.menu', message: 'Menu' },
  open: /*i18n*/ { id: 'interfaces.button.open', message: 'Open' },
  navigation: /*i18n*/ { id: 'sites.navigation', message: 'Site navigation' },
  apply: /*i18n*/ { id: 'sites.apply', message: 'Apply filters' },
  next: /*i18n*/ { id: 'sites.next', message: 'Next page' },
  previous: /*i18n*/ { id: 'sites.previous', message: 'Previous page' },
  details: /*i18n*/ { id: 'sites.details', message: 'View record' },
  submit: /*i18n*/ { id: 'sites.submit', message: 'Submit' },
  thankYou: /*i18n*/ { id: 'form.thanks', message: 'Thanks!  Your answer was recorded.' },
  form: /*i18n*/ { id: 'sites.form', message: 'Open form' },
  editResponse: /*i18n*/ { id: 'forms.edit.open', message: 'Edit your response' },
  continuePayment: /*i18n*/ { id: 'forms.edit.continuePayment', message: 'Continue to payment' },
  value: /*i18n*/ { id: 'sites.value', message: 'Value' },
  untitled: /*i18n*/ { id: 'record.untitled', message: 'Untitled record' },
  category: /*i18n*/ { id: 'sites.category', message: 'Category' },
  unavailable: /*i18n*/ { id: 'sites.unavailable', message: 'This content is unavailable.' },
  website: /*i18n*/ { id: 'sites.website', message: 'Leave this field empty' },
};
export const words = (key: keyof typeof messages, params: Record<string, string | number> = {}) =>
  formatMessage(messages[key].message, params, { locale: 'en-US', html: true });
export const escape = (value: unknown) => escapeHtml(String(value));

const pictureAttributes = (size?: PictureSize) =>
  size ? ` width="${size.width}" height="${size.height}"` : '';

function logoFrame(image: string, size?: PictureSize): string {
  // Automatic image sizing has no intrinsic width in a flex header until the logo loads.
  return size
    ? `<span class="site-logo"><svg${pictureAttributes(size)} viewBox="0 0 ${size.width} ${size.height}" aria-hidden="true" focusable="false"></svg>${image}</span>`
    : image;
}

function videoFrame(video: string, size?: PictureSize): string {
  // A poster's aspect ratio must not resize a player whose dimensions are already known.
  return size
    ? `<span class="site-player"><svg${pictureAttributes(size)} viewBox="0 0 ${size.width} ${size.height}" aria-hidden="true" focusable="false"></svg>${video}</span>`
    : video;
}

function mediaHtml(
  base: string,
  media: { path: string; poster?: string; size?: PictureSize; kind?: 'image' | 'video' },
  alt: string,
  playback?: 'controls' | 'loop',
  enlarge = false,
  lazy = false,
): string {
  const src = `${base}/media/${escape(media.path)}`;
  const video = media.kind === 'video';
  const picture = video
    ? videoFrame(
        `<video src="${src}" controls preload="metadata" playsinline aria-label="${escape(alt) || words('value')}"${playback === 'loop' ? ' muted loop data-site-loop' : ''}${media.poster ? ` poster="${base}/media/${escape(media.poster)}"` : ''}${pictureAttributes(media.size)}></video>`,
        media.size,
      )
    : `<span class="site-picture"><img src="${src}" alt="${escape(alt)}"${lazy ? ' loading="lazy"' : ''}${pictureAttributes(media.size)}></span>`;
  if (!enlarge) return picture;
  const label = video ? `<span class="site-enlarge-label">${words('enlargeVideo')}</span>` : picture;
  const link = `<a class="site-enlarge" href="${src}" data-site-enlarge data-site-close="${words(video ? 'closeVideo' : 'closeImage')}" aria-label="${alt ? words(video ? 'enlargeVideoDescription' : 'enlargeDescription', { description: alt }) : words(video ? 'enlargeVideo' : 'enlarge')}">${label}</a>`;
  // Native video controls and the file link remain separate keyboard targets without scripts.
  return video ? `<span class="site-enlarge-video">${picture}${link}</span>` : link;
}

function buttonHtml(
  action: HeroButton['action'],
  label: string,
  settings: SiteSettings,
  base: string,
  origin: string,
  slug: string,
): string {
  const page = action.kind === 'page' ? settings.pages.find((item) => item.pageId === action.pageId) : null;
  const link =
    action.kind === 'page'
      ? page
        ? { href: `${base}/${page.slug}`, external: false }
        : null
      : siteLink(action.url, settings, base, origin, slug);
  return link
    ? `<a class="site-button" href="${escape(link.href)}"${link.external ? ' rel="noopener noreferrer"' : ''}>${escape(label) || words('open')}</a>`
    : '';
}

function cellHtml(value: string | SiteHistoryEntry[]): string {
  if (typeof value === 'string') return escape(value);
  return value
    .map((entry) =>
      formatMessage(
        messages.historyEntry.message,
        {
          at: {
            html: `<time data-site-history datetime="${escape(entry.at)}">${escape(new Intl.DateTimeFormat('en-US', { dateStyle: 'short', timeStyle: 'short', timeZone: 'UTC' }).format(new Date(entry.at)))}</time>`,
            text: entry.at,
          },
          actor: entry.actor ?? messages.historyPerson.message,
          fields: new Intl.ListFormat('en-US', { type: 'conjunction' }).format(entry.fields),
        },
        { locale: 'en-US', html: true },
      ),
    )
    .join('<br>');
}

// Serialize the shared pure functions so the browser and command bus follow the same visibility rules.
export const SITE_SCRIPT = `const visibleFormQuestions = ${visibleFormQuestions.toString()}
const decodeSiteAnswers = ${decodeSiteAnswers.toString()}
function synchronizeForm(form) {
  const { questions, defaults } = JSON.parse(form.getAttribute('data-site-form'))
  // Disabled controls still hold drafts, but only visible earlier answers can reveal a question.
  const values = new URLSearchParams()
  for (const input of form.querySelectorAll('input, select, textarea')) {
    if (!input.name || (input.type === 'checkbox' && !input.checked)) continue
    if (input instanceof HTMLSelectElement && input.multiple) {
      for (const option of input.selectedOptions) values.append(input.name, option.value)
    } else values.append(input.name, input.value)
  }
  const answers = decodeSiteAnswers(questions, values)
  const byId = new Map(questions.map((question) => [question.fieldId, question]))
  const shown = new Set(visibleFormQuestions(questions, { ...defaults, ...answers }).map((question) => question.fieldId))
  for (const section of form.querySelectorAll('[data-site-question]')) {
    const active = shown.has(section.getAttribute('data-site-question'))
    section.hidden = !active
    for (const input of section.querySelectorAll('input, select, textarea, button')) {
      input.disabled = !active
      input.required = active && input.hasAttribute('data-site-required')
    }
    const question = byId.get(section.getAttribute('data-site-question'))
    if (question.type === 'lineItems') {
      const inputs = [...section.querySelectorAll('input, select, textarea')]
      const first = inputs[0]
      if (first) {
        first.setCustomValidity('')
        if (active && question.required && !answers[question.fieldId].length && inputs.every((input) => input.validity.valid)) {
          first.setCustomValidity(form.getAttribute('data-site-required-message'))
        }
      }
    }
  }
}
for (const form of document.querySelectorAll('form[data-site-form]')) {
  synchronizeForm(form)
  form.addEventListener('input', () => synchronizeForm(form))
  form.addEventListener('change', () => synchronizeForm(form))
  form.addEventListener('click', (event) => {
    const button = event.target instanceof Element && event.target.closest('[data-site-add-line]')
    if (!button) return
    const section = button.closest('[data-site-question]')
    const lines = section.querySelector('[data-site-lines]')
    const index = lines.children.length
    const template = section.querySelector('template')
    const line = template.content.firstElementChild.cloneNode(true)
    line.querySelector('legend').textContent = line.querySelector('legend').textContent.replace('__number__', String(index + 1))
    for (const input of line.querySelectorAll('[name]')) {
      input.name = input.name.replace('.__index__.', '.' + index + '.')
      input.setAttribute('aria-label', input.getAttribute('aria-label').replace(/__number__$/, String(index + 1)))
    }
    lines.append(line)
    synchronizeForm(form)
    line.querySelector('input, select, textarea')?.focus()
  })
}
function localizeHistory() {
  const format = new Intl.DateTimeFormat(document.documentElement.lang, { dateStyle: 'short', timeStyle: 'short' })
  for (const time of document.querySelectorAll('time[data-site-history]')) time.textContent = format.format(new Date(time.dateTime))
}
localizeHistory()
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)')
const root = document.documentElement
const motionEnabled = () => root.dataset.siteMotion !== 'none' && !reducedMotion.matches
let revealObserver
function reveal(node, animate = false) {
  const block = node instanceof Element && node.closest('.site-block')
  if (!block) return
  const pending = block.hasAttribute('data-site-pending')
  if (pending) block.setAttribute('data-site-seen', '')
  block.removeAttribute('data-site-pending')
  if (pending && animate) block.setAttribute('data-site-revealed', '')
  else if (!animate) block.removeAttribute('data-site-revealed')
  revealObserver?.unobserve(block)
}
function revealAll() {
  root.removeAttribute('data-site-reveal-ready')
  for (const block of document.querySelectorAll('.site-block')) reveal(block)
}
function revealHash(hash = location.hash) {
  try { reveal(document.getElementById(decodeURIComponent(hash.slice(1)))) } catch {}
}
function initializeReveals() {
  revealObserver?.disconnect()
  revealAll()
  if (!motionEnabled() || !('IntersectionObserver' in window)) return
  try {
    revealObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) if (entry.isIntersecting) reveal(entry.target, true)
    }, { rootMargin: '0px 0px 48px 0px' })
    for (const block of document.querySelectorAll('.site-block')) {
      if (block.hasAttribute('data-site-seen')) continue
      if (block.getBoundingClientRect().top < innerHeight || block.contains(document.activeElement)) { block.setAttribute('data-site-seen', ''); continue }
      block.setAttribute('data-site-pending', '')
      revealObserver.observe(block)
    }
    revealHash()
    root.setAttribute('data-site-reveal-ready', '')
  } catch { revealAll() }
}
function initializeMotion() {
  initializeReveals()
  if (!motionEnabled()) document.querySelector('.site-brand')?.removeAttribute('data-site-introduce')
}
initializeMotion()
try {
  const key = 'site-visit:' + root.dataset.siteKey
  const visited = sessionStorage.getItem(key)
  sessionStorage.setItem(key, '1')
  if (!visited && motionEnabled()) {
    const brand = document.querySelector('.site-brand')
    const introduce = () => {
      if (!motionEnabled()) return
      brand?.setAttribute('data-site-introduce', '')
      brand?.addEventListener('animationend', () => brand.removeAttribute('data-site-introduce'), { once: true })
    }
    const image = brand?.querySelector('img')
    if (image && !image.complete) image.addEventListener('load', introduce, { once: true })
    else introduce()
  }
} catch {}
document.addEventListener('focusin', (event) => reveal(event.target))
document.addEventListener('beforematch', (event) => reveal(event.target))
document.addEventListener('selectionchange', () => {
  const selection = getSelection()
  if (selection && !selection.isCollapsed) revealAll()
})
document.addEventListener('keydown', (event) => {
  if (((event.ctrlKey || event.metaKey) && ['f', 'g'].includes(event.key.toLowerCase())) || event.key === 'F3') revealAll()
})
document.addEventListener('click', (event) => {
  const link = event.target instanceof Element && event.target.closest('a[href]')
  if (!link) return
  const url = new URL(link.href)
  if (url.origin === location.origin && url.pathname === location.pathname && url.search === location.search) revealHash(url.hash)
})
// Find opened through browser controls can move focus outside the document.
window.addEventListener('blur', revealAll)
window.addEventListener('hashchange', () => revealHash())
window.addEventListener('pageshow', (event) => {
  if (event.persisted) {
    document.querySelector('.site-brand')?.removeAttribute('data-site-introduce')
    initializeMotion()
  }
})
for (const name of ['pageswap', 'pagereveal']) window.addEventListener(name, (event) => {
  const destination = event.activation?.entry?.url
  const base = root.dataset.siteBase
  if (!motionEnabled() || (destination && base && new URL(destination).pathname !== base && !new URL(destination).pathname.startsWith(base + '/'))) event.viewTransition?.skipTransition()
})
reducedMotion.addEventListener('change', initializeMotion)
const mediaStartPositions = new WeakMap()
function playMedia(video) {
  video.play().catch((error) => {
    if (error?.name !== 'AbortError') video.controls = true
  })
}
function initializeMedia() {
  for (const video of document.querySelectorAll('video')) {
    const looping = video.hasAttribute('data-site-loop')
    if (looping) { video.muted = true; video.volume = 0 }
    if (!video.hasAttribute('data-site-ready')) {
      video.setAttribute('data-site-ready', '')
      if (looping) video.addEventListener('volumechange', () => {
        if (!video.muted) video.muted = true
        if (video.volume !== 0) video.volume = 0
      })
      const recover = () => {
        const error = video.error
        if (!error) return
        if (![2, 3].includes(error.code) || video.hasAttribute('data-site-media-recovery') || video.hasAttribute('data-site-media-failed')) {
          video.setAttribute('data-site-media-failed', '')
          video.removeAttribute('data-site-media-reloading')
          video.controls = true
          video.autoplay = false
          video.pause()
          return
        }
        const muted = video.muted, volume = video.volume, loop = video.loop
        const start = mediaStartPositions.get(video) ?? video.currentTime
        const time = Number.isFinite(start) ? start : 0
        const resume = looping || !video.paused
        video.setAttribute('data-site-media-recovery', JSON.stringify({ code: error.code, message: error.message }))
        video.setAttribute('data-site-media-reloading', '')
        video.autoplay = false
        video.addEventListener('loadeddata', () => {
          if (!video.isConnected || video.error || video.hasAttribute('data-site-media-failed')) return
          video.removeAttribute('data-site-media-reloading')
          video.muted = muted
          video.volume = volume
          video.loop = loop
          const moving = motionEnabled()
          const position = moving && Number.isFinite(video.duration) && video.duration > 0 ? (loop ? time % video.duration : Math.min(time, video.duration)) : 0
          if (video.currentTime !== position) video.currentTime = position
          video.setAttribute('data-site-media-recovered', '')
          video.controls = looping ? !moving : true
          video.autoplay = looping && moving
          if (moving && resume) playMedia(video)
          else video.pause()
        }, { once: true })
        video.load()
        video.muted = muted
        video.volume = volume
        video.loop = loop
      }
      video.addEventListener('error', recover)
      recover()
    }
    if (!looping || video.hasAttribute('data-site-media-reloading') || video.hasAttribute('data-site-media-failed')) continue
    video.controls = !motionEnabled()
    video.autoplay = motionEnabled()
    if (!motionEnabled()) { video.pause(); if (video.currentTime !== 0) video.currentTime = 0 }
    else playMedia(video)
  }
}
initializeMedia()
reducedMotion.addEventListener('change', initializeMedia)
document.addEventListener('click', (event) => {
  const link = event.target instanceof Element && event.target.closest('a[data-site-enlarge]')
  if (!link || event.button || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return
  event.preventDefault()
  const dialog = document.createElement('dialog')
  dialog.className = 'site-image-dialog'
  dialog.setAttribute('aria-label', link.getAttribute('aria-label'))
  const close = document.createElement('button')
  close.type = 'button'
  close.textContent = link.getAttribute('data-site-close')
  function finishClose() {
    dialog.close()
    link.focus()
  }
  function closeDialog() {
    if (dialog.hasAttribute('data-site-closing')) return
    if (!motionEnabled()) { finishClose(); return }
    dialog.setAttribute('data-site-closing', '')
    setTimeout(finishClose, 200)
  }
  close.addEventListener('click', closeDialog)
  dialog.addEventListener('cancel', (event) => { event.preventDefault(); closeDialog() })
  const source = (link.closest('.site-enlarge-video') || link).querySelector('img, video')
  const picture = source.cloneNode(true)
  picture.removeAttribute('loading')
  picture.removeAttribute('data-site-ready')
  for (const name of ['recovery', 'reloading', 'recovered', 'failed']) picture.removeAttribute('data-site-media-' + name)
  if (picture instanceof HTMLVideoElement && picture.hasAttribute('data-site-loop')) {
    picture.muted = true
    picture.volume = 0
    const time = source.currentTime
    mediaStartPositions.set(picture, time)
    // Let the new player decode before seeking, and wrap a loop's end back to its beginning.
    picture.addEventListener('loadeddata', () => {
      mediaStartPositions.delete(picture)
      if (!picture.isConnected || picture.hasAttribute('data-site-media-recovery') || !motionEnabled() || !Number.isFinite(picture.duration) || picture.duration <= 0) return
      const position = time % picture.duration
      if (position > 0) picture.currentTime = position
    }, { once: true })
  }
  dialog.append(close, picture)
  // The browser restores focus during close, so the later event must not steal new focus.
  dialog.addEventListener('close', () => dialog.remove(), { once: true })
  document.body.append(dialog)
  dialog.showModal()
  initializeMedia()
  close.focus()
})
async function visit(url) {
  try {
    const response = await fetch(url, { credentials: 'omit' })
    if (!response.ok) { location.assign(url); return }
    const next = new DOMParser().parseFromString(await response.text(), 'text/html')
    const content = next.querySelector('main')
    if (!content) { location.assign(url); return }
    document.querySelector('main').replaceWith(content)
    history.pushState(null, '', url)
    localizeHistory()
    initializeMedia()
    content.focus()
    initializeReveals()
  } catch { location.assign(url) }
}
document.addEventListener('submit', (event) => {
  const form = event.target
  if (!(form instanceof HTMLFormElement) || !form.hasAttribute('data-site-filter')) return
  event.preventDefault()
  const url = new URL(form.action)
  url.search = new URLSearchParams(new FormData(form)).toString()
  visit(url)
})
document.addEventListener('click', (event) => {
  if (!(event.target instanceof Element) || event.button || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return
  if (event.target.closest('a.site-skip')) {
    event.preventDefault()
    history.pushState(null, '', '#content')
    document.getElementById('content').focus()
    return
  }
  const link = event.target.closest('a[data-site-page]')
  if (!link) return
  event.preventDefault()
  visit(new URL(link.href))
})
window.addEventListener('popstate', () => location.reload())`;

export function documentHtml(
  settings: SiteSettings,
  base: string,
  origin: string,
  title: string,
  description: string,
  path: string,
  body: string,
  pageSlug?: string,
  showTitle = true,
  logoSize?: PictureSize,
  banded = false,
): string {
  const canonical = `${origin}${path}`;
  const meta = (property: string, content: string) =>
    `<meta property="${property}" content="${escape(content)}">`;
  const image = settings.socialImage ? `${origin}${base}/media/social` : '';
  const navigation = `<nav aria-label="${words('navigation')}"><ul>${settings.pages
    .filter((page) => page.showInNav !== false)
    .map(
      (page) =>
        `<li><a href="${base}/${page.slug}"${page.slug === pageSlug ? ' aria-current="page"' : ''}>${escape(page.navLabel || page.title)}</a></li>`,
    )
    .join('')}</ul></nav>`;
  const slug = pageSlug ?? settings.pages[0]!.slug;
  const headerButton = settings.headerButton
    ? buttonHtml(settings.headerButton.action, settings.headerButton.label, settings, base, origin, slug)
    : '';
  const footer = settings.footer
    ? settings.footerFormat === 'markdown'
      ? markdownHtml(settings.footer, settings, base, origin, slug)
      : `<p>${escape(settings.footer)}</p>`
    : '';
  return `<!doctype html><html lang="en-US" data-theme="${settings.theme.id}" data-scheme="${settings.theme.scheme}" data-site-motion="${settings.motion}" data-site-key="${escape(settings.slug)}" data-site-base="${escape(base)}"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title><meta name="description" content="${escape(description)}">
<link rel="canonical" href="${escape(canonical)}">${settings.noIndex ? '<meta name="robots" content="noindex, nofollow">' : ''}
${meta('og:type', 'website')}${meta('og:title', title)}${meta('og:description', description)}${meta('og:url', canonical)}${meta('og:site_name', settings.title)}
<meta name="twitter:card" content="${image ? 'summary_large_image' : 'summary'}">${meta('twitter:title', title)}${meta('twitter:description', description)}
${image ? `${meta('og:image', image)}${meta('twitter:image', image)}` : ''}
${settings.favicon ? `<link rel="icon" href="${base}/media/favicon">` : ''}
<link rel="stylesheet" href="${base}/assets/site.css"><link rel="stylesheet" href="${base}/assets/theme.css">
<script src="${base}/assets/site.js" defer></script></head><body class="rio-prose">
<a class="site-skip" href="#content">${words('skip')}</a><header class="site-header${headerButton ? ' site-header-with-button' : ''}"><a class="site-brand" href="${base || '/'}">${settings.logo ? logoFrame(`<img src="${base}/media/logo" alt="${escape(settings.title)}"${pictureAttributes(logoSize)}>`, logoSize) : escape(settings.title)}</a>
<div class="site-nav-wide">${navigation}</div><details class="site-nav"><summary class="site-nav-toggle">${words('menu')}</summary>${navigation}</details>${headerButton}</header>
<main id="content" tabindex="-1"${banded ? ' class="site-banded"' : ''}>${showTitle ? `<h1>${escape(title)}</h1>` : ''}${body}</main><footer class="site-footer">${footer}</footer></body></html>`;
}

export function renderPage(
  settings: SiteSettings,
  page: InterfacePage,
  pageSettings: SitePageSettings,
  content: SiteContent,
  base: string,
  origin: string,
  input: Record<string, string>,
  record?: string,
): string {
  const path = `${base}/${pageSettings.slug}${record ? `/${encodeURIComponent(record)}` : ''}`;
  const body: string[] = [];
  if (!record && content.filters.length)
    body.push(
      `<form action="${path}" method="get" data-site-filter>${content.filters
        .map(
          (filter) =>
            `<label>${escape(filter.label)}${
              filter.choices || filter.checkbox
                ? `<select name="filter.${filter.id}"><option value="">${words('all')}</option>${(filter.checkbox
                    ? [
                        { value: 'true', label: words('yes') },
                        { value: 'false', label: words('no') },
                      ]
                    : filter.choices!
                  )
                    .map(
                      (choice) =>
                        `<option value="${escape(choice.value)}"${choice.value === filter.value ? ' selected' : ''}>${escape(choice.label)}</option>`,
                    )
                    .join('')}</select>`
                : `<input type="search" name="filter.${filter.id}" value="${escape(filter.value)}" maxlength="200">`
            }</label>`,
        )
        .join('')}<button>${words('apply')}</button></form>`,
    );
  const boundaries = [
    ...new Set(page.blocks.flatMap((block) => [block.place.y, block.place.y + block.place.h])),
  ].sort((a, b) => a - b);
  const button = (action: HeroButton['action'], label: string) =>
    buttonHtml(action, label, settings, base, origin, pageSettings.slug);
  const sections = new Map<string, string>();
  const bands = record ? [] : blockBands(page.blocks);
  const banded = bands.some((group) => group.band !== 'none');
  const blocks = [...page.blocks].sort((a, b) => a.place.y - b.place.y || a.place.x - b.place.x);
  const first = blocks[0];
  const headingHero = !record && first?.kind === 'hero' && first.heading ? first.id : null;
  for (const block of blocks) {
    const list = content.records.find((value) => value.id === block.id);
    let inner = '';
    if (list) {
      inner = list.rows
        .map((row, rowIndex) => {
          if (
            !record &&
            block.kind === 'records' &&
            (list.display === 'accordion' || list.display === 'sections')
          ) {
            const field = (index: number) => {
              const selected = list.fields[index];
              if (!selected) return '';
              const value = cellHtml(row.values[selected.id] ?? '');
              return block.showFieldNames === false
                ? value
                : `<strong>${escape(selected.name)}</strong>${value ? `: ${value}` : ''}`;
            };
            const answer = list.fields
              .slice(1)
              .map((_, index) => `<p>${field(index + 1)}</p>`)
              .join('');
            const selectedHeading = field(0);
            const heading = selectedHeading.trim() ? selectedHeading : words('untitled');
            if (list.display === 'accordion') {
              const questionId = `site-question-${encodeURIComponent(block.id)}-${rowIndex}`;
              // A sibling answer avoids the closed disclosure's hidden shadow content during print.
              return `<div class="site-accordion"><details><summary id="${questionId}" aria-controls="${questionId}-answer">${heading}</summary></details><div id="${questionId}-answer" class="site-answer" role="region" aria-labelledby="${questionId}">${answer}</div></div>`;
            }
            const picture = row.cover
              ? mediaHtml(
                  base,
                  { path: row.cover, size: row.coverSize, poster: row.coverPoster, kind: row.coverType },
                  row.alt ?? '',
                  block.playback,
                  block.enlarge,
                  true,
                )
              : '';
            const link = row.link ? siteLink(row.link, settings, base, origin, pageSettings.slug) : null;
            return `<article class="site-record-section"${picture ? ' data-media' : ''}><div class="site-section-words"><h3>${heading}</h3>${answer}${link ? `<a class="site-button" href="${escape(link.href)}"${link.external ? ' rel="noopener noreferrer"' : ''}>${escape(row.linkLabel?.trim() ?? '') || words('open')}</a>` : ''}</div>${picture ? `<div class="site-section-media">${picture}</div>` : ''}</article>`;
          }
          const values =
            !record && block.kind === 'records' && block.showFieldNames === false
              ? list.fields
                  .map((field, index) => {
                    const value = cellHtml(row.values[field.id] ?? '');
                    return value ? `<${index === 0 ? 'h3' : 'p'}>${value}</${index === 0 ? 'h3' : 'p'}>` : '';
                  })
                  .join('')
              : `<dl>${list.fields.map((field) => `<dt>${escape(field.name)}</dt><dd>${cellHtml(row.values[field.id] ?? '')}</dd>`).join('')}</dl>`;
          return `<article>${row.cover && !record ? (block.kind === 'records' && (block.enlarge || row.coverType === 'video') ? `<div class="site-cover">${mediaHtml(base, { path: row.cover, size: row.coverSize, poster: row.coverPoster, kind: row.coverType }, row.alt ?? '', block.playback, block.enlarge, true)}</div>` : `<img class="site-cover" src="${base}/media/${escape(row.cover)}" alt="" loading="lazy"${pictureAttributes(row.coverSize)}>`) : ''}<div class="site-card-body">${values}${!record && list.detail ? `<a class="site-page-link" href="${base}/${pageSettings.slug}/${row.address}">${words('details')}</a>` : ''}</div></article>`;
        })
        .join('');
      inner = `<div class="${!record && list.display === 'cards' ? 'site-cards' : !record && list.display === 'sections' ? 'site-sections' : 'site-list'}">${inner}</div>`;
      if (list.display === 'table' && !record)
        inner = `<div class="site-scroll" tabindex="0" role="region" aria-label="${escape(block.title) || words('value')}"><table><thead><tr>${list.fields.map((field) => `<th scope="col">${escape(field.name)}</th>`).join('')}${list.detail ? `<th scope="col">${words('details')}</th>` : ''}</tr></thead><tbody>${list.rows.map((row) => `<tr>${list.fields.map((field) => `<td>${cellHtml(row.values[field.id] ?? '')}</td>`).join('')}${list.detail ? `<td><a href="${base}/${pageSettings.slug}/${row.address}">${words('details')}</a></td>` : ''}</tr>`).join('')}</tbody></table></div>`;
      const paging = (offset: number, label: 'previous' | 'next') => {
        const params = new URLSearchParams({ ...input, [`offset.${list.id}`]: String(offset) });
        return `<a class="site-page-link" data-site-page href="${path}?${escape(params.toString())}">${words(label)}</a>`;
      };
      const pageSize =
        block.kind === 'records' ? (block.pageSize ?? SITE_LIMITS.pageSize) : SITE_LIMITS.pageSize;
      if (!record && list.offset) inner += paging(Math.max(0, list.offset - pageSize), 'previous');
      if (!record && list.more && list.offset + pageSize <= SITE_LIMITS.offset)
        inner += paging(list.offset + pageSize, 'next');
    } else if (!record && block.kind === 'text')
      inner = `<div class="site-text${block.style === 'lead' ? ' site-lead' : ''}">${markdownHtml(block.text, settings, base, origin, pageSettings.slug, block.style === 'heading')}</div>`;
    else if (!record && block.kind === 'hero') {
      const media = content.media?.[block.id];
      const heading = block.id === headingHero ? 'h1' : 'h2';
      inner = `<div class="site-hero"${media ? ' data-image' : ''}><div>${block.heading ? `<${heading}>${escape(block.heading)}</${heading}>` : ''}<div class="site-text site-lead">${markdownHtml(block.text, settings, base, origin, pageSettings.slug)}</div><div class="site-actions">${block.buttons.map((item) => button(item.action, item.label)).join('')}</div></div>${media ? mediaHtml(base, media, block.alt, block.playback) : ''}</div>`;
    } else if (!record && block.kind === 'media') {
      const media = content.media?.[block.id];
      if (media)
        inner = `<figure>${mediaHtml(base, { ...media, kind: block.mediaType }, block.mediaType === 'image' ? block.alt : block.alt || block.caption || block.title, block.playback, block.enlarge, true)}${block.caption ? `<figcaption>${escape(block.caption)}</figcaption>` : ''}</figure>`;
    } else if (!record && block.kind === 'button')
      inner =
        block.action.kind === 'form'
          ? `<a class="site-button" href="${base}/forms/${page.id}/${block.id}">${escape(block.label) || words('form')}</a>`
          : button(block.action, block.label);
    else if (!record) {
      const summary = content.summaries[block.id];
      if (summary?.kind === 'number')
        inner = `<p class="site-number">${summary.value === null ? '' : escape(summary.value)}</p>`;
      if (summary?.kind === 'error') inner = `<p>${words('unavailable')}</p>`;
      if (summary?.kind === 'chart') {
        const svg = block.kind === 'chart' ? chartSvg(block, summary) : '';
        const legend =
          block.kind === 'chart' && block.chart === 'donut' ? summary.categories : summary.series;
        inner = `${svg}${svg ? `<ul class="site-legend" aria-hidden="true">${legend.map((item, index) => `<li><span class="site-swatch site-series-${index % 8}"></span>${escape(item.label) || words('value')}</li>`).join('')}</ul>` : ''}<div class="${svg ? 'site-visually-hidden' : 'site-scroll'}"><table><caption>${escape(block.title) || words('value')}</caption><thead><tr><th scope="col">${words('category')}</th>${summary.series.map((series) => `<th scope="col">${escape(series.label) || words('value')}</th>`).join('')}</tr></thead><tbody>${summary.categories.map((category, index) => `<tr><th scope="row">${escape(category.label)}</th>${summary.series.map((series) => `<td>${escape(series.values[index] ?? '')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
      }
    }
    const group = banded ? bands.find((item) => item.blocks.some((item) => item.id === block.id)) : undefined;
    const rowOffset = group ? boundaries.indexOf(group.blocks[0]!.place.y) : 0;
    if (inner)
      sections.set(
        block.id,
        `<section class="site-block site-x-${block.place.x} site-w-${Math.min(block.place.w, 12 - block.place.x)} site-row-${boundaries.indexOf(block.place.y) + 1 - rowOffset} site-span-${boundaries.indexOf(block.place.y + block.place.h) - boundaries.indexOf(block.place.y)}" id="site-block-${escape(block.id)}" data-block="${escape(block.id)}" data-kind="${block.kind}">${block.title ? `<h2>${escape(block.title)}</h2>` : ''}${inner}</section>`,
      );
  }
  return documentHtml(
    settings,
    base,
    origin,
    pageSettings.title,
    pageSettings.description,
    path,
    body.join('') +
      (banded
        ? `<div class="site-bands">${bands.map((group) => `<div class="site-band" data-band="${group.band}"><div class="site-grid">${group.blocks.map((block) => sections.get(block.id) ?? '').join('')}</div></div>`).join('')}</div>`
        : `<div class="site-grid">${[...sections.values()].join('')}</div>`),
    pageSettings.slug,
    headingHero === null,
    content.logoSize,
    banded,
  );
}
