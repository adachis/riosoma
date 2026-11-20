import { useState, type FocusEvent } from 'react';
import { useLingui } from '@lingui/react/macro';
import { faLocationCrosshairs } from '@fortawesome/free-solid-svg-icons';
import {
  LIMITS,
  coordinatesText,
  parseCoordinates,
  roundCoordinate,
  sameValue,
  type LocationValue,
} from '@riosoma/contracts';
import { Button, TextField } from '@riosoma/ui';
import './fields.css';

export interface LocationInputProps {
  value: LocationValue | null;
  labelId?: string;
  label?: string;
  autoFocus?: boolean;
  readOnly?: boolean;
  /** Saves when focus leaves the place, or only through Save when false */
  saveOnBlur?: boolean;
  onChange: (value: LocationValue | null) => void;
  /** With `saveOnBlur` false: leaves without saving */
  onCancel?: () => void;
}

/** Two numbers, whatever their range: a pair of coordinates written well but out of bounds. */
const TWO_NUMBERS = /^\s*\(?\s*[+-]?\d+(?:[.,]\d+)?\s*[,;\s]\s*[+-]?\d+(?:[.,]\d+)?\s*\)?\s*$/;

function hasGeolocation(): boolean {
  return typeof navigator !== 'undefined' && 'geolocation' in navigator;
}

/**
 * A place: an optional label, such as an address, and coordinates typed or pasted as
 * `lat, lng`.  "Use my location" asks the browser only when pressed.
 */
export function LocationInput({
  value,
  labelId,
  label: accessibleLabel,
  autoFocus,
  readOnly,
  saveOnBlur = true,
  onChange,
  onCancel,
}: LocationInputProps) {
  const { t } = useLingui();
  const [source, setSource] = useState(value);
  const [label, setLabel] = useState(value?.label ?? '');
  const [coordinates, setCoordinates] = useState(value ? coordinatesText(value) : '');
  const [error, setError] = useState('');
  const [locating, setLocating] = useState(false);
  if (!sameValue(source, value)) {
    setSource(value);
    setLabel(value?.label ?? '');
    setCoordinates(value ? coordinatesText(value) : '');
    setError('');
  }

  function save(nextLabel = label, nextCoordinates = coordinates): boolean {
    const text = nextLabel.trim();
    // Saving by hand always reports back, so whatever holds the input open can close it.
    if (nextCoordinates.trim() === '') {
      if (text === '') {
        setError('');
        if (value !== null || !saveOnBlur) onChange(null);
        return true;
      }
      setError(
        t({
          id: 'fields.location.needsCoordinates',
          message: 'Add coordinates, or use your location, to save this place.',
        }),
      );
      return false;
    }
    const place = parseCoordinates(nextCoordinates);
    if (!place) {
      setError(
        TWO_NUMBERS.test(nextCoordinates)
          ? t({
              id: 'fields.location.range',
              message: 'Latitude runs from -90 to 90, and longitude from -180 to 180.',
            })
          : t({
              id: 'fields.location.coordinatesFormat',
              message: 'Type the latitude and longitude, like 40.7128, -74.0060.',
            }),
      );
      return false;
    }
    setError('');
    setCoordinates(coordinatesText(place));
    const next: LocationValue = { ...place, label: text || null };
    if (!sameValue(value, next) || !saveOnBlur) onChange(next);
    return true;
  }

  function locate() {
    if (!hasGeolocation()) return;
    setLocating(true);
    setError('');
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setLocating(false);
        const place = {
          lat: roundCoordinate(position.coords.latitude),
          lng: roundCoordinate(position.coords.longitude),
        };
        const text = coordinatesText(place);
        setCoordinates(text);
        save(label, text);
      },
      (failure) => {
        setLocating(false);
        setError(
          failure.code === failure.PERMISSION_DENIED
            ? t({
                id: 'fields.location.denied',
                message: 'Your browser didn’t share your location.  Type the coordinates instead.',
              })
            : t({
                id: 'fields.location.unavailable',
                message: 'Your location isn’t available right now.  Type the coordinates instead.',
              }),
        );
      },
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 60_000 },
    );
  }

  const errorId = `${labelId ?? 'location'}-location-error`;
  return (
    <div
      className="rio-location-input"
      role="group"
      aria-labelledby={labelId}
      aria-label={labelId ? undefined : accessibleLabel}
      onBlurCapture={(event: FocusEvent<HTMLDivElement>) => {
        if (!saveOnBlur || readOnly || event.currentTarget.contains(event.relatedTarget)) return;
        save();
      }}
      onKeyDownCapture={(event) => {
        if (
          event.key === 'Enter' &&
          !event.nativeEvent.isComposing &&
          event.target instanceof HTMLInputElement
        ) {
          event.preventDefault();
          if (!readOnly) save();
        }
      }}
    >
      <TextField
        label={t({ id: 'fields.location.label', message: 'Place' })}
        placeholder={t({ id: 'fields.location.labelHint', message: 'Address or name' })}
        value={label}
        autoFocus={autoFocus}
        isReadOnly={readOnly}
        maxLength={LIMITS.locationLabelLength}
        onChange={setLabel}
      />
      <div className="rio-location-input__coordinates">
        <TextField
          label={t({ id: 'fields.location.coordinates', message: 'Latitude, longitude' })}
          placeholder={t({ id: 'fields.location.example', message: '40.7128, -74.0060' })}
          value={coordinates}
          isReadOnly={readOnly}
          isInvalid={error !== ''}
          validationBehavior="aria"
          aria-describedby={errorId}
          onChange={(next) => {
            setCoordinates(next);
            if (error) setError('');
          }}
        />
        {hasGeolocation() && !readOnly && (
          <Button icon={faLocationCrosshairs} isPending={locating} onPress={locate}>
            {t({ id: 'fields.location.useMine', message: 'Use my location' })}
          </Button>
        )}
      </div>
      <div id={errorId} className="rio-field-input__error" aria-live="polite">
        {error}
      </div>
      {!saveOnBlur && (
        <div className="rio-field-input__actions">
          <Button
            variant="primary"
            isDisabled={readOnly}
            onPress={() => {
              save();
            }}
          >
            {t({ id: 'fields.location.save', message: 'Save' })}
          </Button>
          {onCancel && (
            <Button onPress={onCancel}>{t({ id: 'fields.location.cancel', message: 'Cancel' })}</Button>
          )}
        </div>
      )}
    </div>
  );
}
