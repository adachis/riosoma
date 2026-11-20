import type { z } from 'zod';
import { APP_CATALOG, AppError } from '@riosoma/contracts';

/** Presets declare their setting advice alongside the rules, so only catalog messages are exposed. */
function appSettingMessage(message: string): boolean {
  return (
    /^sources\.app\./.test(message) &&
    APP_CATALOG.some((entry) =>
      entry.settings.some(
        (setting) =>
          setting.requiredMessageId === message ||
          setting.invalidMessageId === message ||
          (setting.type === 'address' && Object.values(setting.addressMessageIds ?? {}).includes(message)),
      ),
    )
  );
}

/**
 * Parses a request part with a zod schema.  Failures become field-level i18n keys the client can
 * show beside each input, never zod's own English messages.
 */
export function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const fields: Record<string, string> = {};
  let ruleMessage: string | undefined;
  for (const issue of result.error.issues) {
    const path = issue.path.join('.') || '_';
    const knownRule =
      issue.code === 'custom' &&
      (/^(?:data\.validation\.(?:patternSyntax|bounds|dateBound)|sources\.app\.(?:unknown|undeclaredSetting|settingRequired|settingInvalid|address))$/.test(
        issue.message,
      ) ||
        appSettingMessage(issue.message))
        ? issue.message
        : undefined;
    if (knownRule) ruleMessage ??= knownRule;
    fields[path] ??= knownRule ?? `validation.${issue.code}`;
  }
  throw new AppError('validation_failed', ruleMessage ?? 'errors.validationFailed', { fields });
}
