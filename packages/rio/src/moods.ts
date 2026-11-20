export const RIO_MOODS = ['idle', 'thinking', 'happy', 'oops', 'napping', 'celebrating'] as const;

export type RioMood = (typeof RIO_MOODS)[number];
