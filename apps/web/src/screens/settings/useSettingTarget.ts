import { useEffect, useEffectEvent, useRef } from 'react';
import type { RefObject } from 'react';
import { useLocation } from '@tanstack/react-router';
import type { SettingDefinition } from './Setting';

const SETTING_OPEN = 'rio-setting-open';

/** A repeated selection of the current address still returns focus from search to the setting. */
export function activateSetting(href: string) {
  window.dispatchEvent(new CustomEvent(SETTING_OPEN, { detail: href }));
}

/** Observe lazy destinations because their controls can mount after navigation. */
export function useSettingTarget(
  body: RefObject<HTMLElement | null>,
  target: SettingDefinition | undefined,
  onMissing?: () => void,
) {
  const location = useLocation();
  const visited = useRef('');
  const missing = useEffectEvent(() => onMissing?.());
  useEffect(() => {
    if (!target || !body.current) {
      visited.current = '';
      return;
    }
    const key = location.href;
    if (visited.current === key) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let missingTimer: ReturnType<typeof setTimeout> | undefined;
    let node: HTMLElement | undefined;
    const open = () => {
      node = [...body.current!.querySelectorAll<HTMLElement>('[data-setting-id]')].find(
        (item) => item.dataset.settingId === target.id && item.dataset.settingPage === target.page,
      );
      if (!node) {
        clearTimeout(missingTimer);
        if (
          body.current!.querySelector('[data-setting-id="overview"]') &&
          !body.current!.querySelector('.rio-spinner, .rio-feature-loading')
        )
          missingTimer = setTimeout(() => missing(), 200);
        return;
      }
      clearTimeout(missingTimer);
      if (
        node.closest('[aria-hidden="true"], [aria-busy="true"], [inert]') ||
        node.querySelector('[aria-busy="true"]')
      )
        return;
      let parent = node.parentElement;
      while (parent && parent !== body.current) {
        if (parent.classList.contains('rio-disclosure')) {
          const trigger = parent.querySelector<HTMLButtonElement>('button[aria-expanded="false"]');
          if (trigger) {
            trigger.click();
            return;
          }
        }
        parent = parent.parentElement;
      }
      const visible = (item: HTMLElement) => {
        if (
          item.closest('[hidden], [aria-hidden="true"], [aria-busy="true"], [inert], [aria-disabled="true"]')
        )
          return false;
        const style = getComputedStyle(item);
        return style.visibility !== 'hidden' && style.visibility !== 'collapse' && style.display !== 'none';
      };
      if (!visible(node)) return;
      const controls = [
        ...node.querySelectorAll<HTMLElement>(
          'input:not([type="hidden"]), select, textarea, button, [role="radio"], a[href]',
        ),
      ];
      const usable = (item: HTMLElement) => !item.matches(':disabled') && visible(item);
      const control =
        [
          ...node.querySelectorAll<HTMLElement>(
            'input:not(:disabled):not([type="hidden"]), select:not(:disabled), textarea:not(:disabled)',
          ),
        ].find(usable) ??
        [...node.querySelectorAll<HTMLElement>('button:not(:disabled), [role="radio"], a[href]')].find(
          usable,
        );
      // A completed loading region can focus a read-only row instead of its disabled controls.
      if (!control && controls.length && !node.closest('[aria-busy="false"]')) return;
      const destination = control ?? node;
      destination.focus({ preventScroll: true });
      if (document.activeElement !== destination) return;
      visited.current = key;
      const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      node.scrollIntoView({ block: 'start', behavior: reduced ? 'instant' : 'smooth' });
      node.dataset.settingHighlighted = 'true';
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (node) delete node.dataset.settingHighlighted;
      }, 2400);
      observer.disconnect();
    };
    const observer = new MutationObserver(open);
    const observe = () =>
      observer.observe(body.current!, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: [
          'hidden',
          'aria-expanded',
          'aria-hidden',
          'aria-busy',
          'inert',
          'disabled',
          'aria-disabled',
          'class',
          'style',
        ],
      });
    observe();
    open();
    const repeat = (event: Event) => {
      if ((event as CustomEvent<string>).detail === location.pathname) {
        observe();
        open();
      }
    };
    window.addEventListener(SETTING_OPEN, repeat);
    return () => {
      visited.current = '';
      window.removeEventListener(SETTING_OPEN, repeat);
      observer.disconnect();
      clearTimeout(timer);
      clearTimeout(missingTimer);
      if (node) delete node.dataset.settingHighlighted;
    };
  }, [body, target, location.href, location.pathname]);
}
