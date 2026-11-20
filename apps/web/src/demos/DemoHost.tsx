import { createContext, useContext, useState, type ReactNode } from 'react';
import type { DocModuleMeta } from '@riosoma/contracts';
import { LazyBoundary, lazyFeature } from '../shell/lazy';

const Runtime = lazyFeature(() =>
  import('./DemoRuntime').then((module) => ({ default: module.DemoRuntime })),
);

export interface Demos {
  start(module: DocModuleMeta): void;
  running: boolean;
  preload?(): Promise<void>;
}
const DemosContext = createContext<Demos | null>(null);

export function useDemos(): Demos | null {
  return useContext(DemosContext);
}

export interface DemoHostProps {
  children: ReactNode;
  onStart?(module: DocModuleMeta): void;
  onEnd?(module: DocModuleMeta): void;
}

/** A stable provider keeps the current route mounted while Show-me loads and runs. */
export function DemoHost({ children, onStart, onEnd }: DemoHostProps) {
  const [request, setRequest] = useState<{ id: number; module: DocModuleMeta } | null>(null);
  const [running, setRunning] = useState(false);
  return (
    <DemosContext.Provider
      value={{
        running,
        preload: Runtime.preload,
        start: (module) => {
          if (!running) setRequest((previous) => ({ id: (previous?.id ?? 0) + 1, module }));
        },
      }}
    >
      {children}
      {request && (
        <LazyBoundary
          size="dialog"
          onDismiss={() => {
            setRequest(null);
            setRunning(false);
          }}
        >
          <Runtime request={request} onRunning={setRunning} onStart={onStart} onEnd={onEnd} />
        </LazyBoundary>
      )}
    </DemosContext.Provider>
  );
}
