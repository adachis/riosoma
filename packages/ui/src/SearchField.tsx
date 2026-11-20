import { faMagnifyingGlass, faXmark } from '@fortawesome/free-solid-svg-icons';
import { useLingui } from '@lingui/react/macro';
import { Icon } from '@riosoma/icons';
import {
  Button as AriaButton,
  Input as AriaInput,
  SearchField as AriaSearchField,
  type SearchFieldProps as AriaSearchFieldProps,
} from 'react-aria-components';
import type { ReactNode } from 'react';
import { cx } from './cx';
import { FieldShell, type FieldErrorMessage, type FieldSize } from './FieldShell';
import './SearchField.css';
import { Tooltip, TooltipTrigger } from './Tooltip';

export interface SearchFieldProps extends Omit<
  AriaSearchFieldProps,
  | 'className'
  | 'style'
  | 'children'
  | 'label'
  | 'description'
  | 'errorMessage'
  | 'placeholder'
  | 'validationState'
> {
  /** Visible label.  Callers pass text that is already translated. */
  label?: ReactNode;
  /** Help text under the control. */
  description?: ReactNode;
  /** Error text, shown only while the field is invalid. */
  errorMessage?: FieldErrorMessage;
  placeholder?: string;
  size?: FieldSize;
  className?: string;
}

/**
 * A field for filtering.  The magnifying glass says what it is for, the clear button appears only
 * once there is something to clear, and Escape clears from the keyboard.  Its target has reserved
 * room at inline end, so the query never moves when it shows up.
 */
export function SearchField({
  label,
  description,
  errorMessage,
  placeholder,
  size = 'md',
  className,
  ...rest
}: SearchFieldProps) {
  const { t } = useLingui();
  const clearLabel = t({ id: 'ui.searchField.clear', message: 'Clear search' });
  return (
    <AriaSearchField {...rest} className={cx('rio-field', 'rio-search-field', className)} data-size={size}>
      {({ isEmpty, isDisabled, isReadOnly }) => (
        <FieldShell
          label={label}
          description={description}
          errorMessage={errorMessage}
          icon={faMagnifyingGlass}
          isRequired={rest.isRequired}
          actions={
            isEmpty || isDisabled || isReadOnly ? null : (
              <TooltipTrigger>
                <AriaButton
                  className="rio-field__action rio-search-field__clear"
                  aria-label={clearLabel}
                  data-tooltip={clearLabel}
                >
                  <Icon icon={faXmark} size="0.85em" />
                </AriaButton>
                <Tooltip>{clearLabel}</Tooltip>
              </TooltipTrigger>
            )
          }
        >
          <AriaInput className="rio-field__input" placeholder={placeholder} />
        </FieldShell>
      )}
    </AriaSearchField>
  );
}
