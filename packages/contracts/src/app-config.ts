import { z } from 'zod';

/**
 * `GET /api/config`: settings from the server's environment that the web app reads as it runs.
 * Anyone may read them, signed in or not, so nothing here is ever secret.
 */
export const AppConfig = z.object({
  map: z.object({
    /** The MapLibre style map views draw with, or null when the server turns maps off */
    styleUrl: z.string().nullable(),
  }),
  /** The version the server runs, which is the version of the web app it serves */
  version: z.string().max(60).optional(),
});
export type AppConfig = z.infer<typeof AppConfig>;
