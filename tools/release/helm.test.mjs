import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const chart = new URL('../../deploy/helm/riosoma/', import.meta.url);

test('the connector chart restricts live sessions to one replica during deployment and upgrades', async () => {
  for (const file of ['values.yaml', 'ci/full-values.yaml']) {
    const values = await readFile(new URL(file, chart), 'utf8');
    const connectors = /^connectors:\n((?:[ \t].*\n|\n)*)/m.exec(values)?.[1];
    assert.ok(connectors, file);
    assert.match(connectors, /^  replicaCount: 1$/m, file);
  }
  const template = await readFile(new URL('templates/connectors.yaml', chart), 'utf8');
  assert.match(template, /{{- if ne \(toString \.Values\.connectors\.replicaCount\) "1" }}\s*{{- fail "connectors\.replicaCount must be exactly 1 because live sessions are stored in one process" }}\s*{{- end }}/);
  assert.ok(template.indexOf('fail ') < template.indexOf('kind: Deployment'));
  const deployment = template.slice(template.indexOf('kind: Deployment'));
  assert.match(deployment, /\nspec:\n  replicas: {{ \.Values\.connectors\.replicaCount }}\n  strategy:\n    type: Recreate\n  selector:/);
  const docs = await readFile(new URL('../../docs/install/kubernetes.md', import.meta.url), 'utf8');
  assert.match(docs, /`connectors\.replicaCount`.*exactly one.*`Recreate`/);
});
