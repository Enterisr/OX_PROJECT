import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BasicReportBuilder } from '../src/report.js';
import type { Finding } from '../src/domain.js';
import { MemoryStore } from './helpers.js';

function dependency(id: string, name: string, version: string, severity: Finding['severity']): Finding {
  return { id, ruleId: 'dependency-vulnerability', dependency: { name, version }, severity,
    title: `${name}@${version}: ${id}`, description: id, filePath: 'package-lock.json', line: 10 };
}

test('same dependency version shares one action with highest severity while findings and counts are preserved', async () => {
  const scan = await new MemoryStore().create('https://github.com/owner/repo');
  const findings = [dependency('one', 'react-router', '7.8.2', 'medium'), dependency('two', 'react-router', '7.8.2', 'high')];
  const original = structuredClone(findings);
  const report = await new BasicReportBuilder().build(scan, findings);
  assert.equal(report.actionGroups!.length, 1);
  const group = report.actionGroups![0];
  assert.equal(group.title, 'Update react-router@7.8.2');
  assert.equal(group.severity, 'high');
  assert.deepEqual(group.findingIds, ['two', 'one']);
  assert.match(group.recommendation, /all their affected ranges/);
  assert.equal(report.findings.length, 2);
  assert.deepEqual(report.summary, { total: 2, bySeverity: { critical: 0, high: 1, medium: 1, low: 0 } });
  assert.deepEqual(findings, original);
});

test('different packages, versions, lockfiles, source findings and missing metadata remain separate', async () => {
  const scan = await new MemoryStore().create('https://github.com/owner/repo');
  const findings: Finding[] = [
    dependency('one', 'router', '1.0.0', 'low'),
    dependency('two', 'router', '2.0.0', 'high'),
    dependency('three', 'other', '1.0.0', 'medium'),
    { ...dependency('four', 'router', '1.0.0', 'low'), filePath: 'other/package-lock.json' },
    { ...dependency('five', 'router', '1.0.0', 'high'), ruleId: 'dynamic-eval' },
    { ...dependency('six', 'router', '1.0.0', 'medium'), dependency: undefined },
  ];
  const report = await new BasicReportBuilder().build(scan, findings);
  assert.equal(report.actionGroups!.length, findings.length);
  assert.deepEqual(report.actionGroups!.flatMap(group => group.findingIds).sort(), findings.map(finding => finding.id).sort());
  const empty = await new BasicReportBuilder().build(scan, []);
  assert.deepEqual(empty.actionGroups, []);
});
