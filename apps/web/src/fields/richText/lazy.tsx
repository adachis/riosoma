import { LazyBoundary, lazyFeature } from '../../shell/lazy';
import type { RichTextInputProps } from './RichTextInput';
import { RichTextPreview } from './RichTextPreview';
export type { RichTextInputProps, RichTextHandle } from './RichTextInput';

const Input = lazyFeature(() =>
  import('./RichTextInput').then((module) => ({ default: module.RichTextInput })),
);

export function RichTextInput(props: RichTextInputProps) {
  return (
    <LazyBoundary
      fallback={
        <RichTextPreview
          editor
          literal={props.initialText != null}
          value={props.initialText ?? props.value ?? ''}
        />
      }
    >
      <Input {...props} />
    </LazyBoundary>
  );
}

const View = lazyFeature(() => import('./RichTextView').then((module) => ({ default: module.RichTextView })));

export function RichTextView(props: { value: string; className?: string }) {
  return (
    <LazyBoundary fallback={<RichTextPreview {...props} />}>
      <View {...props} />
    </LazyBoundary>
  );
}
