import { Component, type ReactNode } from 'react';
import { isAssetLoadError, recoverAssets } from '../asset-recovery';
import { BootError } from './BootError';

/** Rendering failures outside a route must leave a usable screen as well. */
export class AppErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean; error?: unknown }
> {
  override state: { failed: boolean; error?: unknown } = { failed: false };
  static getDerivedStateFromError(error: unknown) {
    return { failed: true, error };
  }
  override componentDidCatch(error: unknown) {
    if (isAssetLoadError(error)) void recoverAssets();
  }
  override render() {
    return this.state.failed ? <BootError error={this.state.error} /> : this.props.children;
  }
}
