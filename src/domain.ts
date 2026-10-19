export type Severity = "critical" | "high" | "medium" | "low";
export type ScanStatus = "queued" | "running" | "completed" | "failed";

export interface Scan {
  id: string;
  repositoryUrl: string;
  createdAt: string;
  status: ScanStatus;
  progress: number;
  stage: string;
  error: string | null;
}
//made flexiable to support multiple kinds of analyzing and reports. (premium\free tier,
//  ai driven/rule based, different things that we searched for)
export interface Finding {
  dependency?: { name: string; version: string };
  ruleId?: string;
  recommendation?: string;
  id: string;
  severity: Severity;
  title: string;
  description: string;
  filePath: string;
  line: number;
}

export interface ReportContent {
  actionGroups?: {
    title: string;
    severity: Severity;
    recommendation: string;
    findingIds: string[];
  }[];
  analysis?: string;
  repository: {
    commitSha: string;
    defaultBranch: string;
    textFileCount: number;
    skippedFileCount: number;
  };
  summary: { total: number; bySeverity: Record<Severity, number> };
  findings: Finding[];
}

export interface Report {
  id: string;
  scanId: string;
  createdAt: string;
  engine: string;
  content: ReportContent;
}

export interface RepositorySnapshot {
  repositoryUrl: string;
  commitSha: string;
  defaultBranch: string;
  files: { path: string; content: string }[];
  skippedFileCount: number;
}

export type ProgressCallback = (
  percent: number,
  stage: string,
) => Promise<void>;

export interface RepositoryReader {
  read(
    repositoryUrl: string,
    onProgress: ProgressCallback,
    commitSha?: string,
  ): Promise<RepositorySnapshot>;
}

export interface Scanner {
  scan(
    repository: RepositorySnapshot,
    onProgress: ProgressCallback,
  ): Promise<Finding[]>;
}

export interface ReportBuilder {
  readonly engine: string;
  build(scan: Scan, findings: Finding[], repository?: RepositorySnapshot): Promise<Omit<ReportContent, 'repository'>>;
}

export interface ScanStore {
  create(repositoryUrl: string): Promise<Scan>;
  get(id: string): Promise<Scan | undefined>;
  update(
    id: string,
    status: ScanStatus,
    progress: number,
    stage: string,
    error?: string,
  ): Promise<void>;
  complete(
    scanId: string,
    findings: Finding[],
    engine: string,
    content: ReportContent,
  ): Promise<void>;
  getReport(scanId: string): Promise<Report | undefined>;
}
