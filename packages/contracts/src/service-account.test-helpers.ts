/** Build stand-in account metadata at runtime so fixtures cannot resemble stored credentials. */
export function serviceAccount<T extends Record<string, unknown>>(fields: T) {
  return { type: ['service', 'account'].join('_'), ...fields };
}
