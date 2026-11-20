import type { TokenMeta } from '@riosoma/contracts';
import { api } from '../../../api';

export const TOKEN_KEY = ['tokens'];

/** The person's tokens.  Settings reads them too, so the section stays listed for anyone who has some. */
export const tokensQuery = {
  queryKey: TOKEN_KEY,
  queryFn: ({ signal }: { signal: AbortSignal }) => api<TokenMeta[]>('/api/tokens', { signal }),
};
