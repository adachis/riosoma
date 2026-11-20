import { msg } from '@lingui/core/macro';
import type { MessageDescriptor } from '@lingui/core';
import type { AiFieldTier, AiFieldTrigger } from '@riosoma/contracts';

/** The AI field type as the type menu, the header, and help name it. */
export const AI_FIELD_NAME = msg({ id: 'fields.ai.name', message: 'AI' });
export const AI_FIELD_DESCRIPTION = msg({
  id: 'fields.ai.description',
  message: 'A value a model writes from a prompt that reads the record’s fields.',
});

export const TIER_NAMES: Record<AiFieldTier, MessageDescriptor> = {
  fast: msg({ id: 'fields.ai.tier.fast', message: 'Fast' }),
  careful: msg({ id: 'fields.ai.tier.careful', message: 'Careful' }),
};

export const TRIGGER_NAMES: Record<AiFieldTrigger, MessageDescriptor> = {
  referencedChange: msg({
    id: 'fields.ai.trigger.referencedChange',
    message: 'When a field in the prompt changes',
  }),
  onRequest: msg({ id: 'fields.ai.trigger.onRequest', message: 'Only when someone asks' }),
};

export const PENDING = msg({ id: 'fields.ai.pending', message: 'Generating…' });
