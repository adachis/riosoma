import { expect, it } from 'vitest';
import { highRiskAlerts } from './zap-report';

it('gates by reported risk, including unknown rules, and accepts only named exceptions', () => {
  const alerts = [
    { pluginid: '1', riskcode: '2', name: 'Medium' },
    { pluginid: '2', riskcode: '3', name: 'High' },
    { pluginid: '3', riskcode: '4', name: 'Critical' },
  ];
  expect(highRiskAlerts({ site: [{ alerts }] }, {})).toEqual(alerts.slice(1));
  expect(highRiskAlerts({ site: [{ alerts }] }, { '2': 'Reviewed exception' })).toEqual(alerts.slice(2));
});

it('fails closed on missing reports, empty site inventories, or unrecognized risk', () => {
  for (const report of [
    null,
    {},
    { site: [] },
    { site: [{}] },
    { site: [{ alerts: [{ pluginid: '1', riskcode: 'unknown', name: 'Malformed' }] }] },
  ])
    expect(() => highRiskAlerts(report, {})).toThrow();
});
