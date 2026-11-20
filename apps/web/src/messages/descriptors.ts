import type { MessageDescriptor } from '@lingui/core';

const descriptors: Record<string, MessageDescriptor> = {};

/** Feature messages join the registry when their active catalog is requested. */
export function registerMessages(messages: Record<string, MessageDescriptor>): void {
  Object.assign(descriptors, messages);
}

export function messageDescriptor(key: string): MessageDescriptor | undefined {
  return descriptors[key];
}
