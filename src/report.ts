import type { Finding, ReportBuilder, ReportContent, RepositorySnapshot, Scan, Severity } from './domain.js';

const recommendations: Record<string, string> = {
  'dynamic-eval': 'Replace eval with ordinary function calls or JSON.parse for JSON data. Check whether untrusted input can reach this call.',
  'request-shell': 'Avoid a shell: use execFile with a fixed executable and separate, validated arguments. Check how request input reaches this command.',
  'tls-verification': 'Enable certificate verification. For a private CA, configure the trusted CA certificate instead of disabling verification.',
};
const priority: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

export class BasicReportBuilder implements ReportBuilder {
  readonly engine = 'basic-rules-v1';

  async build(_scan: Scan, findings: Finding[], repository?: RepositorySnapshot): Promise<Omit<ReportContent, 'repository'>> {
    const bySeverity = { critical: 0, high: 0, medium: 0, low: 0 };
    for (const finding of findings) bySeverity[finding.severity]++;
    const reviewed = findings.map((finding) => ({ ...finding,
      recommendation: finding.recommendation ?? recommendations[finding.ruleId ?? ''] ?? 'Inspect the reported code and verify its security impact before making changes.',
    })).sort((a, b) => priority[a.severity] - priority[b.severity]);
    const first = reviewed[0];
    const actionGroups: NonNullable<ReportContent['actionGroups']> = [];
    const dependencyGroups = new Map<string, (typeof actionGroups)[number]>();
    for (const finding of reviewed) {
      const dependency = finding.ruleId === 'dependency-vulnerability' ? finding.dependency : undefined;
      const key = dependency ? JSON.stringify([finding.filePath, dependency.name, dependency.version]) : undefined;
      const existing = key ? dependencyGroups.get(key) : undefined;
      if (existing) {
        existing.findingIds.push(finding.id);
        continue;
      }
      const group = {
        title: dependency ? `Update ${dependency.name}@${dependency.version}` : finding.title,
        severity: finding.severity,
        recommendation: dependency
          ? `Review all listed advisories and update ${dependency.name} to a version outside all their affected ranges. Regenerate the lockfile and run your tests. For a transitive dependency, update the parent dependency where possible.`
          : finding.recommendation,
        findingIds: [finding.id],
      };
      actionGroups.push(group);
      if (key) dependencyGroups.set(key, group);
    }
    return {
      actionGroups,
      summary: { total: findings.length, bySeverity }, findings: reviewed,
      analysis: `${first ? `Review ${first.title.toLowerCase()} at ${first.filePath}:${first.line} first (${first.severity} severity).` : 'No matching patterns were found.'} This POC checks three JavaScript/TypeScript patterns using syntax analysis. ${repository?.files.some(({ path }) => path === 'package-lock.json') ? 'The server also checks root npm lockfile package versions against OSV for known vulnerabilities.' : 'Dependency check skipped: no root package-lock.json was provided.'} Results require manual verification; no data-flow or AI analysis is performed. A scan with no findings does not establish that the repository is secure.`,
    };
  }
}
