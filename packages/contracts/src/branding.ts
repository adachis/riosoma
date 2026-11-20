import { z } from 'zod';

export const LOGO_MAX_BYTES = 256 * 1024;
export const LogoUpload = z
  .object({
    type: z.enum(['image/svg+xml', 'image/png']),
    data: z
      .string()
      .max(Math.ceil(LOGO_MAX_BYTES / 3) * 4)
      .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
  })
  .strict();
export type LogoUpload = z.infer<typeof LogoUpload>;
export const LogoAsset = z.object({
  surface: z.enum(['light', 'dark']).optional(),
  key: z.string().uuid(),
  type: z.enum(['image/svg+xml', 'image/png']),
  storage: z.enum(['postgres', 'local', 's3', 'azure-blob']),
});
export const OrganizationLogo = z.object({
  main: LogoAsset,
  compact: LogoAsset.nullable(),
  mode: z.enum(['theme', 'original']),
});
export type OrganizationLogo = z.infer<typeof OrganizationLogo>;
export const LogoChange = z
  .object({
    main: LogoUpload.nullable().optional(),
    compact: LogoUpload.nullable().optional(),
    mode: z.enum(['theme', 'original']),
  })
  .strict();
export type LogoChange = z.infer<typeof LogoChange>;
export const OrganizationBranding = z.object({
  name: z.string(),
  logo: OrganizationLogo.nullable(),
});
export type OrganizationBranding = z.infer<typeof OrganizationBranding>;

export const OrganizationAppearance = z
  .object({
    defaultTheme: z
      .string()
      .regex(/^[a-z0-9-]{1,64}$/)
      .nullable(),
    allowedThemes: z
      .array(z.string().regex(/^[a-z0-9-]{1,64}$/))
      .min(1)
      .max(200)
      .nullable(),
  })
  .strict();
export type OrganizationAppearance = z.infer<typeof OrganizationAppearance>;
