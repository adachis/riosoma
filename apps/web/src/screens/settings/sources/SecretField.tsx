import { faXmark } from '@fortawesome/free-solid-svg-icons';
import { Trans, useLingui } from '@lingui/react/macro';
import type { SecretName } from '@riosoma/contracts';
import { Button, PasswordField, SecretArea, Text } from '@riosoma/ui';
import { MULTILINE_SECRETS, SECRET_HINTS, SECRET_LABELS } from './labels';
import './sources.css';

export interface SecretFieldProps {
  app?: boolean;
  name: SecretName;
  /** The server already holds a value for this secret. */
  stored: boolean;
  /** The stored value is marked for removal, so the update sends null for it. */
  removed: boolean;
  /** A new value is being typed over the stored one. */
  replacing: boolean;
  value: string;
  /** Help that takes the place of the secret's own, for a kind that needs its own words */
  hint?: string;
  label?: string;
  isRequired?: boolean;
  isDisabled?: boolean;
  errorMessage?: string;
  onChange(value: string): void;
  onReplace(): void;
  onRemove(remove: boolean): void;
}

/**
 * One secret.  A stored secret never shows its value: the row says only that one is held, and
 * offers to replace or remove it.  Leaving a replacement empty keeps the stored value, so pressing
 * Replace by mistake costs nothing.
 */
export function SecretField({
  app,
  name,
  stored,
  removed,
  replacing,
  value,
  hint: kindHint,
  label: fieldLabel,
  isRequired,
  isDisabled,
  errorMessage,
  onChange,
  onReplace,
  onRemove,
}: SecretFieldProps) {
  const { t, i18n } = useLingui();
  const label =
    fieldLabel ?? (app ? t({ id: 'sources.app.key', message: 'Key' }) : i18n._(SECRET_LABELS[name]));

  if (stored && !replacing) {
    return (
      <div className="rio-sources__secret" data-removed={removed || undefined}>
        <Text className="rio-sources__secret-name">{label}</Text>
        {removed ? null : (
          <Text variant="muted">
            {app ? (
              t({ id: 'sources.app.keyStored', message: 'Stored' })
            ) : (
              <Trans id="sources.secret.stored">Stored</Trans>
            )}
          </Text>
        )}
        <span className="rio-sources__secret-actions">
          <Button size="sm" isDisabled={isDisabled} onPress={onReplace}>
            {app ? (
              t({ id: 'sources.app.keyReplace', message: 'Replace' })
            ) : (
              <Trans id="sources.secret.replace">Replace</Trans>
            )}
          </Button>
          <Button
            size="sm"
            variant={removed ? 'danger' : 'secondary'}
            aria-pressed={removed}
            isDisabled={isDisabled}
            onPress={() => onRemove(!removed)}
            aria-label={
              app
                ? t({ id: 'sources.app.keyRemove', message: 'Remove' })
                : t({ id: 'sources.secret.remove', message: 'Remove' })
            }
            icon={faXmark}
          />
        </span>
      </div>
    );
  }

  const hint = kindHint ?? (SECRET_HINTS[name] ? i18n._(SECRET_HINTS[name]) : undefined);
  const common = {
    label,
    ...(hint ? { description: hint } : {}),
    value,
    onChange,
    isRequired,
    isDisabled,
    isInvalid: Boolean(errorMessage),
    errorMessage,
    autoComplete: 'off',
  };
  return MULTILINE_SECRETS.has(name) ? <SecretArea {...common} rows={4} /> : <PasswordField {...common} />;
}
