const messages = {
  'sdk.request.canceled': 'The call was canceled.',
  'sdk.route.relative': 'A route must be a relative path within the configured server base.',
} as const;

export function message(id: keyof typeof messages): string {
  return messages[id];
}
