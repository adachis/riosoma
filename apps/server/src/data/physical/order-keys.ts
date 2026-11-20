/**
 * Keys for a list view's own order of records.  A key is an exact decimal, carried as text so no
 * precision is lost on the way to and from the database.  A record nobody has moved has its row
 * number as its key, which is a whole number.  Keys given to moved records never are, and each
 * falls strictly between its neighbors, so no two records ever share a key and there is always
 * room for another between any two.
 */

/** A decimal as whole digits and how many of them come after the point. */
interface Decimal {
  digits: bigint;
  scale: number;
}

const DECIMAL = /^(-)?(\d+)(?:\.(\d+))?$/;

function parse(text: string): Decimal {
  const match = DECIMAL.exec(text.trim());
  if (!match) throw new RangeError(`Not a decimal: ${text}`);
  const fraction = match[3] ?? '';
  const digits = BigInt(`${match[2]!}${fraction}`);
  return { digits: match[1] ? -digits : digits, scale: fraction.length };
}

const power = (scale: number): bigint => 10n ** BigInt(scale);

/** Division that rounds toward negative infinity, for a positive divisor. */
function floorDiv(value: bigint, divisor: bigint): bigint {
  const quotient = value / divisor;
  return value % divisor !== 0n && value < 0n ? quotient - 1n : quotient;
}

function ceilDiv(value: bigint, divisor: bigint): bigint {
  return -floorDiv(-value, divisor);
}

/** The shortest way to write a decimal: no zeros after the last digit past the point. */
function format(digits: bigint, scale: number): string {
  const negative = digits < 0n;
  const text = (negative ? -digits : digits).toString().padStart(scale + 1, '0');
  const whole = text.slice(0, text.length - scale);
  const fraction = text.slice(text.length - scale).replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

/** A key written the shortest way, so two ways of writing one number compare equal. */
export function normalKey(text: string): string {
  const value = parse(text);
  return format(value.digits, value.scale);
}

/**
 * The key for a record placed between two others: the shortest decimal strictly between them that
 * isn't a whole number, as near their middle as that allows.  Null on either side means no record
 * is that way, so the key only has to be past the other one.
 */
export function keyBetween(low: string | null, high: string | null): string {
  let lo: Decimal;
  let hi: Decimal;
  if (low === null && high === null) return '0.5';
  if (low === null) {
    hi = parse(high!);
    lo = { digits: ceilDiv(hi.digits, power(hi.scale)) - 1n, scale: 0 };
  } else if (high === null) {
    lo = parse(low);
    hi = { digits: floorDiv(lo.digits, power(lo.scale)) + 1n, scale: 0 };
  } else {
    lo = parse(low);
    hi = parse(high);
  }
  const top = Math.max(lo.scale, hi.scale);
  const a = lo.digits * power(top - lo.scale);
  const b = hi.digits * power(top - hi.scale);
  if (a >= b) throw new RangeError('There is no room between these keys');
  // At one more digit than either side has, there are at least nine candidates, and no more than
  // one of any three in a row is a whole number, so the search always ends by then.
  for (let scale = 1; scale <= top + 1; scale++) {
    let first: bigint;
    let last: bigint;
    if (scale >= top) {
      const factor = power(scale - top);
      first = a * factor + 1n;
      last = b * factor - 1n;
    } else {
      const factor = power(top - scale);
      first = floorDiv(a, factor) + 1n;
      last = ceilDiv(b, factor) - 1n;
    }
    if (first > last) continue;
    const denominator = 2n * power(top);
    let middle = floorDiv(2n * (a + b) * power(scale) + denominator, 2n * denominator);
    if (middle < first) middle = first;
    if (middle > last) middle = last;
    for (const candidate of [middle, middle - 1n, middle + 1n]) {
      if (candidate < first || candidate > last || candidate % power(scale) === 0n) continue;
      return format(candidate, scale);
    }
  }
  throw new RangeError('There is no room between these keys');
}
