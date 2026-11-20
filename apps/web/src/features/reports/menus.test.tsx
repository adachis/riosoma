import { cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GridConfig, newId, type ViewMeta } from '@riosoma/contracts';
import { renderShell, view } from '../../screens/database/shell/test-support';
import { ViewTabs } from '../../screens/database/shell/ViewTabs';
import { useViewDownload } from '../../screens/database/view/download';
import { ViewToolbar } from '../../screens/database/view/ViewToolbar';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function Tabs({
  views,
  canEdit,
  onReports,
}: {
  views: ViewMeta[];
  canEdit: boolean;
  onReports(id: string): void;
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
      onReports={onReports}
    />
  );
}

const itemNames = () => screen.getAllByRole('menuitem').map((item) => item.textContent);

describe('where scheduled reports are offered', () => {
  it('sits with the downloads in every view’s menu but a form’s, for readers too', async () => {
    const onReports = vi.fn();
    const grid = view('Grid');
    const form = { ...view('Intake'), type: 'form' as const };
    const user = userEvent.setup();
    renderShell(<Tabs views={[grid, form]} canEdit={false} onReports={onReports} />);
    await user.click(screen.getByRole('button', { name: 'More for Grid' }));
    expect(itemNames()).toEqual([
      'Download CSV',
      'Download Excel',
      'Word document',
      'PowerPoint deck',
      'Scheduled reports',
    ]);
    await user.click(screen.getByRole('menuitem', { name: 'Scheduled reports' }));
    expect(onReports).toHaveBeenCalledExactlyOnceWith(grid.id);
    await user.click(screen.getByRole('button', { name: 'More for Intake' }));
    expect(itemNames()).not.toContain('Scheduled reports');
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
          reports: { label: 'Scheduled reports', onAction },
        }}
        onConfigChange={() => {}}
      />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'More' }));
    await user.click(screen.getByRole('menuitem', { name: 'Scheduled reports' }));
    expect(onAction).toHaveBeenCalledOnce();
  });
});
