import { cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GridConfig, newId, type ViewMeta, type ViewType } from '@riosoma/contracts';
import { renderShell, view } from '../../screens/database/shell/test-support';
import { ViewTabs } from '../../screens/database/shell/ViewTabs';
import { useViewDownload } from '../../screens/database/view/download';
import { ViewToolbar } from '../../screens/database/view/ViewToolbar';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const typed = (name: string, type: ViewType): ViewMeta => ({ ...view(name), type });

function Tabs({ views, onSubscribe }: { views: ViewMeta[]; onSubscribe(id: string): void }) {
  const downloads = useViewDownload();
  return (
    <ViewTabs
      views={views}
      activeViewId={views[0]!.id}
      hrefFor={(id) => `/view/${id}`}
      canEdit={false}
      onNavigate={() => {}}
      onCreate={() => {}}
      onRename={() => {}}
      onDuplicate={() => {}}
      onDelete={() => {}}
      downloads={downloads}
      onSubscribe={onSubscribe}
    />
  );
}

const itemNames = () => screen.getAllByRole('menuitem').map((item) => item.textContent);

describe('where subscribing in a calendar app is offered', () => {
  it('sits with the downloads of calendars, timelines, and Gantt charts, for readers too', async () => {
    const onSubscribe = vi.fn();
    const calendar = typed('Launch calendar', 'calendar');
    const timeline = typed('Roadmap', 'timeline');
    const gantt = typed('Plan', 'gantt');
    const grid = typed('Everything', 'grid');
    const user = userEvent.setup();
    renderShell(<Tabs views={[calendar, timeline, gantt, grid]} onSubscribe={onSubscribe} />);
    for (const shown of [calendar, timeline, gantt]) {
      await user.click(screen.getByRole('button', { name: `More for ${shown.name}` }));
      expect(itemNames()).toEqual([
        'Download CSV',
        'Download Excel',
        'Word document',
        'PowerPoint deck',
        'Subscribe in a calendar app',
      ]);
      await user.click(screen.getByRole('menuitem', { name: 'Subscribe in a calendar app' }));
      expect(onSubscribe).toHaveBeenLastCalledWith(shown.id);
    }
    await user.click(screen.getByRole('button', { name: 'More for Everything' }));
    expect(itemNames()).not.toContain('Subscribe in a calendar app');
  });

  it('is in the toolbar’s overflow too', async () => {
    const onAction = vi.fn();
    vi.spyOn(window, 'matchMedia').mockReturnValue({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as MediaQueryList);
    renderShell(
      <ViewToolbar
        config={GridConfig.parse({})}
        fields={[]}
        primaryFieldId={newId('field')}
        downloads={{
          csv: 'Download CSV',
          xlsx: 'Download Excel',
          busy: false,
          pending: false,
          onDownload: () => {},
          subscribe: { label: 'Subscribe in a calendar app', onAction },
        }}
        onConfigChange={() => {}}
      />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'More' }));
    await user.click(screen.getByRole('menuitem', { name: 'Subscribe in a calendar app' }));
    expect(onAction).toHaveBeenCalledOnce();
  });
});
