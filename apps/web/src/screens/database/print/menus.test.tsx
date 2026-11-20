import { cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GridConfig, newId, type ViewMeta } from '@riosoma/contracts';
import { renderShell, view } from '../shell/test-support';
import { ViewTabs } from '../shell/ViewTabs';
import { useViewDownload } from '../view/download';
import { ViewToolbar } from '../view/ViewToolbar';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function Tabs({
  views,
  canEdit,
  onPrint,
}: {
  views: ViewMeta[];
  canEdit: boolean;
  onPrint(id: string): void;
}) {
  const downloads = useViewDownload();
  return (
    <ViewTabs
      views={views}
      activeViewId={views[0]!.id}
      hrefFor={(id) => `/view/${id}`}
      canEdit={canEdit}
      onNavigate={() => {}}
      onCreate={() => {}}
      onRename={() => {}}
      onDuplicate={() => {}}
      onDelete={() => {}}
      downloads={downloads}
      onPrint={onPrint}
    />
  );
}

const itemNames = () => screen.getAllByRole('menuitem').map((item) => item.textContent);

describe('where printing is offered', () => {
  it('sits beside the downloads in the menu of every grid, gallery, and kanban, for readers too', async () => {
    const onPrint = vi.fn();
    const grid = view('Grid');
    const gallery = { ...view('Cards'), type: 'gallery' as const };
    const chart = { ...view('Chart'), type: 'chart' as const };
    renderShell(<Tabs views={[grid, gallery, chart]} canEdit onPrint={onPrint} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'More for Grid' }));
    expect(itemNames().slice(0, 5)).toEqual([
      'Download CSV',
      'Download Excel',
      'Word document',
      'PowerPoint deck',
      'Print or save as PDF',
    ]);
    await user.click(screen.getByRole('menuitem', { name: 'Print or save as PDF' }));
    expect(onPrint).toHaveBeenCalledExactlyOnceWith(grid.id);
    await user.click(screen.getByRole('button', { name: 'More for Cards' }));
    await user.click(screen.getByRole('menuitem', { name: 'Print or save as PDF' }));
    expect(onPrint).toHaveBeenLastCalledWith(gallery.id);
    // A chart has nothing to print as records.
    await user.click(screen.getByRole('button', { name: 'More for Chart' }));
    expect(itemNames()).not.toContain('Print or save as PDF');
    await user.keyboard('{Escape}');
    cleanup();
    renderShell(<Tabs views={[grid]} canEdit={false} onPrint={onPrint} />);
    await user.click(screen.getByRole('button', { name: 'More for Grid' }));
    expect(itemNames()).toEqual([
      'Download CSV',
      'Download Excel',
      'Word document',
      'PowerPoint deck',
      'Print or save as PDF',
    ]);
  });

  it('is in the toolbar’s overflow too, for a row too narrow for the view tabs', async () => {
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
          pdf: { label: 'Print or save as PDF', onAction },
        }}
        onConfigChange={() => {}}
      />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'More' }));
    expect(itemNames()).toEqual(['Download CSV', 'Download Excel', 'Print or save as PDF']);
    await user.click(screen.getByRole('menuitem', { name: 'Print or save as PDF' }));
    expect(onAction).toHaveBeenCalledOnce();
  });
});
