import { DashboardFilters } from '@riosoma/contracts';

/** The dashboard's personal conditions travel with its link, including an open drill-down. */
export function dashboardFiltersToken(filters: DashboardFilters): string | null {
  return filters.length ? JSON.stringify(filters) : null;
}

/** Malformed links never become data requests.  Field access is checked by the server. */
export function parseDashboardFilters(token: string | null): DashboardFilters {
  if (!token || token.length > 65_536) return [];
  try {
    const parsed = DashboardFilters.safeParse(JSON.parse(token));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}
