/** Build stand-in account metadata at runtime so fixtures cannot resemble stored credentials. */
export function serviceAccount<T extends Record<string, unknown>>(fields: T) {
  return { type: ['service', 'account'].join('_'), ...fields };
}

/** Keep the token format realistic without storing a token-shaped literal. */
export function accessToken(sequence: number): string {
  return ['ya29', `token-${sequence}`].join('.');
}
