import { plural } from '@lingui/core/macro';
import { useLingui } from '@lingui/react/macro';
import type { FieldMeta } from '@riosoma/contracts';
import { unplacedFormulas } from './dates';
import './DateFormulaNote.css';

/** Says which date formulas a calendar, timeline, or Gantt view's date choices leave out, and why. */
export function DateFormulaNote({ fields }: { fields: readonly FieldMeta[] }) {
  const { t, i18n } = useLingui();
  const names = unplacedFormulas(fields).map((field) => field.name);
  if (!names.length) return null;
  const formulas = new Intl.ListFormat(i18n.locale, { type: 'conjunction' }).format(names);
  const count = names.length;
  return (
    <p className="rio-date-formula-note">
      {t({
        id: 'views.dates.formulaNote',
        message: plural(count, {
          one: `${formulas} isn’t offered.  It’s a date formula that can’t be sorted or filtered, so it can’t place records here.`,
          other: `${formulas} aren’t offered.  They’re date formulas that can’t be sorted or filtered, so they can’t place records here.`,
        }),
      })}
    </p>
  );
}
