import { useContext } from 'react';
import { LazyBoundary, lazyFeature } from '../../shell/lazy';
import { Context } from './SettingsDraftContext';

const SaveBar = lazyFeature(() =>
  import('./SettingsDraft').then((module) => ({ default: module.SettingsSaveBar })),
);

export function SettingsDraftFooter() {
  const context = useContext(Context);
  return context?.active ? (
    <LazyBoundary size="controls">
      <SaveBar />
    </LazyBoundary>
  ) : null;
}
