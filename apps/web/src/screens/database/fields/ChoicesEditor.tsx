import { useState } from 'react';
import { DialogTrigger } from 'react-aria-components';
import { faPlus, faXmark } from '@fortawesome/free-solid-svg-icons';
import { useLingui } from '@lingui/react/macro';
import { CHOICE_COLORS, LIMITS, newId, type Choice } from '@riosoma/contracts';
import {
  Button,
  ChoicePill,
  ColorSwatchPicker,
  Dialog,
  Popover,
  TextField,
  Tooltip,
  TooltipTrigger,
  SortableList,
  SortableItem,
  SortableDropZone,
  moveList,
} from '@riosoma/ui';
import './ChoicesEditor.css';

export interface ChoicesEditorProps {
  choices: readonly Choice[];
  onChange: (choices: Choice[]) => void;
}

export function duplicateChoiceNames(choices: readonly Choice[]): Set<string> {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const choice of choices) {
    const name = choice.name.trim().toLowerCase();
    if (name && seen.has(name)) duplicates.add(name);
    seen.add(name);
  }
  return duplicates;
}

export function ChoicesEditor({ choices, onChange }: ChoicesEditorProps) {
  const { t } = useLingui();
  const [focusId, setFocusId] = useState<string | null>(null);
  const duplicates = duplicateChoiceNames(choices);
  const optionName = t({ id: 'field.choices.name', message: 'Option name' });

  function update(id: string, patch: Partial<Choice>) {
    onChange(choices.map((choice) => (choice.id === id ? { ...choice, ...patch } : choice)));
  }

  return (
    <section className="rio-choices-editor" aria-label={t({ id: 'field.choices.label', message: 'Options' })}>
      <h3 className="rio-choices-editor__title">{t({ id: 'field.choices.label', message: 'Options' })}</h3>
      <SortableList
        items={choices.map((choice) => ({ id: choice.id, name: choice.name.trim() || optionName }))}
        onMove={(from, to) => onChange([...moveList(choices, from, to)])}
      >
        <ol
          className="rio-choices-editor__rows"
          aria-label={t({ id: 'field.choices.label', message: 'Options' })}
        >
          {choices.map((choice) => {
            const name = choice.name.trim() || optionName;
            const colorLabel = t({ id: 'field.choices.color', message: `Color of ${name}` });
            const removeLabel = t({ id: 'field.choices.remove', message: `Remove ${name}` });
            return (
              <SortableItem
                key={choice.id}
                id={choice.id}
                as="li"
                altMoveScope="row"
                className="rio-choices-editor__row"
              >
                <>
                  <DialogTrigger>
                    <Button type="button" className="rio-choices-editor__color" aria-label={colorLabel}>
                      <ChoicePill name={name} color={choice.color} />
                    </Button>
                    <Popover>
                      <Dialog aria-label={colorLabel} hideCloseButton>
                        <ColorSwatchPicker
                          label={colorLabel}
                          value={choice.color}
                          onChange={(color) => update(choice.id, { color })}
                        />
                      </Dialog>
                    </Popover>
                  </DialogTrigger>
                  <TextField
                    aria-label={optionName}
                    value={choice.name}
                    autoFocus={choice.id === focusId}
                    maxLength={LIMITS.nameLength}
                    onChange={(name) => update(choice.id, { name })}
                    validationBehavior="aria"
                    isInvalid={duplicates.has(choice.name.trim().toLowerCase())}
                    errorMessage={t({
                      id: 'field.choices.duplicate',
                      message: 'Another option already has this name.',
                    })}
                  />
                  <TooltipTrigger>
                    <Button
                      type="button"
                      variant="quiet"
                      icon={faXmark}
                      aria-label={removeLabel}
                      onPress={() => onChange(choices.filter(({ id }) => id !== choice.id))}
                    />
                    <Tooltip>{removeLabel}</Tooltip>
                  </TooltipTrigger>
                </>
              </SortableItem>
            );
          })}
        </ol>
        <SortableDropZone />
      </SortableList>
      <Button
        type="button"
        icon={faPlus}
        isDisabled={choices.length >= LIMITS.choicesPerField}
        onPress={() => {
          const id = newId('choice');
          const lastColor = choices.at(-1)?.color;
          const colorIndex = lastColor ? CHOICE_COLORS.indexOf(lastColor) + 1 : 0;
          setFocusId(id);
          onChange([...choices, { id, name: '', color: CHOICE_COLORS[colorIndex % CHOICE_COLORS.length]! }]);
        }}
        aria-label={t({ id: 'field.choices.add', message: 'Add option' })}
      />
    </section>
  );
}
