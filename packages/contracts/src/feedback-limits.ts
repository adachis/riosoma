export const FEEDBACK_LIMITS = {
  /** The longest message, in characters */
  messageLength: 5_000,
  /** The longest reply, in characters */
  replyLength: 2_000,
  /** The largest screenshot, in bytes */
  screenshotBytes: 2 * 1024 * 1024,
  /** How many pieces one person may send in an hour */
  perHour: 20,
  /** How many of the page's recent errors go with it */
  errors: 20,
  errorMessageLength: 500,
  errorStackLength: 4_000,
  /** Feedback a page of the inbox holds */
  page: 30,
} as const;
