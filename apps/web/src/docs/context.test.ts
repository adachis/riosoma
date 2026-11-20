import { describe, expect, it } from 'vitest';
import { chooseContext, collectContext, sectionId } from './context';
import { listModules, loadModule } from './loader';

describe('contextual help', () => {
  it('prefers the active form view over the generic database route across shipped modules', async () => {
    const modules = (
      await Promise.all((await listModules('en-US')).map(({ id }) => loadModule(id, 'en-US')))
    ).filter((module) => module !== null);
    document.body.innerHTML =
      '<main><div data-help-view="form"></div><div data-anchor="view.settings.form"></div></main>';
    try {
      const context = collectContext(document, '/db00000000000000/tbl00000000000000/viw00000000000000');
      expect(chooseContext(modules, context).best).toEqual({ id: 'forms', section: 'designing-the-form' });
      document.querySelector('[data-help-view]')!.remove();
      expect(chooseContext(modules, collectContext(document, context.route)).best).toEqual({
        id: 'forms',
        section: 'designing-the-form',
      });
      expect(chooseContext(modules, { ...context, surface: ['view.filter'] }).best).toEqual({
        id: 'views',
        section: 'filter',
      });
      expect(chooseContext(modules, { ...context, focused: 'field.name' }).best).toEqual({
        id: 'fields',
        section: 'adding-and-editing-fields',
      });
    } finally {
      document.body.innerHTML = '';
    }
  });

  it('captures the active view when its settings are closed and keeps grid help on editing', async () => {
    const modules = (
      await Promise.all(['editing', 'forms', 'views', 'list-and-map'].map((id) => loadModule(id, 'en-US')))
    ).filter((module) => module !== null);
    const route = '/db00000000000000/tbl00000000000000/viw00000000000000';
    document.body.innerHTML = '<main><div data-help-view="map"></div></main>';
    try {
      expect(chooseContext(modules, collectContext(document, route)).best).toEqual({
        id: 'list-and-map',
        section: 'placing-records-on-a-map',
      });
      document.querySelector<HTMLElement>('[data-help-view]')!.dataset.helpView = 'grid';
      expect(chooseContext(modules, collectContext(document, route)).best).toEqual({
        id: 'editing',
        section: 'moving-around',
      });
    } finally {
      document.body.innerHTML = '';
    }
  });

  it('prefers a focused control, then an open surface, then the route, then page anchors', async () => {
    const modules = (
      await Promise.all(['views', 'fields', 'themes', 'editing'].map((id) => loadModule(id, 'en-US')))
    ).filter((module) => module !== null);
    expect(
      chooseContext(modules, {
        route: '/settings/appearance',
        anchors: ['grid'],
        surface: ['view.filter'],
        focused: 'field.name',
      }).best,
    ).toEqual({ id: 'fields', section: 'adding-and-editing-fields' });
    expect(
      chooseContext(modules, { route: '/settings/appearance', anchors: ['grid'], surface: ['view.filter'] })
        .best,
    ).toEqual({ id: 'views', section: 'filter' });
    expect(chooseContext(modules, { route: '/settings/appearance', anchors: ['grid'] }).best?.id).toBe(
      'themes',
    );
    expect(chooseContext(modules, { route: '/unknown', anchors: ['grid'] }).best?.id).toBe('editing');
    expect(chooseContext(modules, { route: '/unknown', anchors: [] }).best).toBeNull();
  });

  it('orders competing topics deterministically and lists the other matches', async () => {
    const modules = (
      await Promise.all(['fields', 'views', 'formulas'].map((id) => loadModule(id, 'en-US')))
    ).filter((module) => module !== null);
    const context = {
      route: '/',
      focused: 'field.formula.expression',
      anchors: ['field.name', 'view.filter'],
    };
    const selected = chooseContext(modules, context);
    expect(selected.best?.id).toBe('formulas');
    expect(selected.others.map((topic) => topic.id)).toEqual(['fields', 'views']);
    expect(chooseContext([...modules].reverse(), context)).toEqual(selected);
  });

  it('ignores hidden controls and help itself, and captures the active dialog', () => {
    document.body.innerHTML =
      '<main data-anchor="grid"><button data-anchor="view.filter">Filter</button><div style="display:none"><input data-anchor="view.sort"></div></main><div role="dialog"><input data-anchor="field.name"></div><div hidden data-anchor="share.people"></div><aside data-help-content><input data-anchor="palette.query"></aside>';
    const input = document.querySelector<HTMLInputElement>('[data-anchor="field.name"]')!;
    input.focus();
    const context = collectContext(document, '/');
    expect(context.focused).toBe('field.name');
    expect(context.surface).toEqual(['field.name']);
    expect(context.anchors).toEqual(['grid', 'view.filter', 'field.name']);
    document.body.innerHTML = '';
  });

  it('uses the same stable section ID for headings and deep links', () => {
    expect(sectionId('Filter, sort, and group')).toBe('filter-sort-and-group');
  });

  it('keeps the question on the screen when the command palette opens', () => {
    document.body.innerHTML =
      '<main data-anchor="grid"><input data-anchor="view.filter"></main><div class="rio-palette" role="dialog"><input data-anchor="palette.query"></div>';
    const previous = document.querySelector('main input')!;
    document.querySelector<HTMLInputElement>('.rio-palette input')!.focus();
    expect(collectContext(document, '/', previous)).toEqual({
      route: '/',
      anchors: ['grid', 'view.filter'],
      focused: 'view.filter',
      surface: [],
    });
    expect(collectContext(document, '/').focused).toBeUndefined();
    document.body.innerHTML = '';
  });

  it('keeps shared shell controls and unknown settings pages out of the screen fallback', async () => {
    document.body.innerHTML =
      '<nav data-anchor="shell.settings"></nav><button data-anchor="notifications.open"></button><main></main>';
    expect(collectContext(document, '/').anchors).toEqual([]);
    const module = (await loadModule('editing', 'en-US'))!;
    expect(
      chooseContext([module], { route: '/admin/connections/integrations', anchors: [] }).best,
    ).toBeNull();
    expect(
      chooseContext([module], { route: '/db00000000000000/tbl00000000000000/viw00000000000000', anchors: [] })
        .best?.id,
    ).toBe('editing');
    document.body.innerHTML = '';
  });
});
