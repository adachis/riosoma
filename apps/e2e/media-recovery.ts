import type { BrowserContext, Page, TestInfo } from '@playwright/test';

type Fault = {
  element: number;
  label: string | null;
  source: string;
  enlarged: boolean;
  code: number;
  message: string;
  attempted: boolean;
  recovered: boolean;
  final: { error: number | null; ready: number; muted: boolean };
};
type Entry = {
  event: number;
  url: string;
  scripted: boolean;
  motion: string | undefined;
  reducedMotion: boolean;
  fault: Fault;
};
const reports = new WeakMap<BrowserContext, Map<Page, Map<number, Entry>>>();

export async function recordMediaRecovery(context: BrowserContext, scripted = true): Promise<void> {
  const pages = new Map<Page, Map<number, Entry>>();
  reports.set(context, pages);
  await context.exposeBinding('__recordSiteMediaFault', ({ page }, entry: Entry) => {
    const events = pages.get(page) ?? new Map<number, Entry>();
    events.set(entry.event, entry);
    pages.set(page, events);
  });
  await context.addInitScript((scripted) => {
    const send = Reflect.get(window, '__recordSiteMediaFault') as (entry: Entry) => Promise<void>;
    const elements = new WeakMap<HTMLVideoElement, number>();
    const pending = new WeakMap<HTMLVideoElement, { event: number; fault: Fault; eligible: boolean }>();
    let sequence = 0;
    let eventSequence = 0;
    const report = (event: number, fault: Fault) => {
      void send({
        event,
        url: location.href,
        scripted,
        motion: document.documentElement.dataset.siteMotion,
        reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
        fault,
      });
    };
    const state = (video: HTMLVideoElement) => ({
      error: video.error?.code ?? null,
      ready: video.readyState,
      muted: video.muted,
    });
    document.addEventListener(
      'error',
      (event) => {
        const video = event.target;
        if (!(video instanceof HTMLVideoElement) || !video.error) return;
        if (!elements.has(video)) elements.set(video, ++sequence);
        const fault: Fault = {
          element: elements.get(video)!,
          label: video.getAttribute('aria-label'),
          source: video.currentSrc || video.src,
          enlarged: !!video.closest('dialog'),
          code: video.error.code,
          message: video.error.message,
          attempted: false,
          recovered: false,
          final: state(video),
        };
        const id = ++eventSequence;
        pending.set(video, { event: id, fault, eligible: !video.hasAttribute('data-site-media-recovery') });
        report(id, fault);
      },
      true,
    );
    new MutationObserver((records) => {
      const videos = new Set(records.map((record) => record.target));
      for (const video of videos) {
        if (!(video instanceof HTMLVideoElement)) continue;
        const entry = pending.get(video);
        if (!entry) continue;
        const { fault, eligible } = entry;
        fault.final = state(video);
        fault.attempted ||= eligible && video.hasAttribute('data-site-media-recovery');
        fault.recovered =
          fault.attempted &&
          video.hasAttribute('data-site-media-recovered') &&
          !video.error &&
          video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA;
        report(entry.event, fault);
      }
    }).observe(document, {
      subtree: true,
      attributes: true,
      attributeFilter: [
        'data-site-media-recovery',
        'data-site-media-reloading',
        'data-site-media-recovered',
        'data-site-media-failed',
      ],
    });
  }, scripted);
}

export async function attachMediaRecovery(context: BrowserContext, info: TestInfo): Promise<void> {
  for (const events of reports.get(context)?.values() ?? []) {
    const entries = [...events.values()];
    if (!entries.length) continue;
    const first = entries[0]!;
    await info.attach('site-media-recovery', {
      contentType: 'application/json',
      body: JSON.stringify({
        url: first.url,
        scripted: first.scripted,
        motion: first.motion,
        reducedMotion: first.reducedMotion,
        faults: entries.map((entry) => entry.fault),
      }),
    });
  }
  reports.delete(context);
}
