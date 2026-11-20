export interface ScanAlert {
  pluginid: string;
  riskcode: string;
  name: string;
}

/** Reject missing or malformed reports, and retain lower-risk findings for review. */
export function highRiskAlerts(report: unknown, accepted: Record<string, string>): ScanAlert[] {
  const sites = (report as { site?: { alerts?: ScanAlert[] }[] } | null)?.site;
  if (!Array.isArray(sites) || !sites.length) throw new Error('ZAP report has no scanned sites');
  return sites.flatMap((site) => {
    if (!Array.isArray(site.alerts)) throw new Error('ZAP report has no alert inventory');
    return site.alerts.filter((alert) => {
      if (!/^\d+$/.test(alert.pluginid) || !/^[0-4]$/.test(String(alert.riskcode)) || !alert.name)
        throw new Error('Malformed ZAP alert');
      return Number(alert.riskcode) >= 3 && !accepted[alert.pluginid];
    });
  });
}
