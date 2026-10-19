import type {
  ReportBuilder,
  RepositoryReader,
  Scan,
  Scanner,
  ScanStore,
} from "./domain.js";
import { RepositoryReadError } from "./github-handler.js";
import { DependencyScanError } from "./dependency-scanner.js";

export class ScanOrchestrator {
  //scans currently running
  private readonly pending = new Set<Promise<void>>();

  constructor(
    private readonly store: ScanStore,
    private readonly repositories: RepositoryReader,
    private readonly scanner: Scanner,
    private readonly reports: ReportBuilder,
    private readonly logError: (error: unknown) => void,
  ) {}

  enqueue(scan: Scan, commitSha?: string) {
    //wait after you finish the tasks in event loop. then, run it

    const task = new Promise<void>((resolve) => setImmediate(resolve))
      .then(() => this.run(scan, commitSha))
      .catch(this.logError);
    this.pending.add(task);
    void task.then(() => this.pending.delete(task));
  }

  async drain() {
    await Promise.all(this.pending);
  }

  private async run(scan: Scan, commitSha?: string) {
    try {
      await this.store.update(scan.id, "running", 5, "Starting");
      const onProgress = async (percent: number, stage: string) => {
        await this.store.update(scan.id, "running", percent, stage);
      };
      const repository = await this.repositories.read(
        scan.repositoryUrl,
        onProgress,
        commitSha,
      );
      const findings = await this.scanner.scan(repository, onProgress);
      await this.store.update(scan.id, "running", 85, "Building report");
      const content = {
        ...(await this.reports.build(scan, findings, repository)),
        repository: {
          commitSha: repository.commitSha,
          defaultBranch: repository.defaultBranch,
          textFileCount: repository.files.length,
          skippedFileCount: repository.skippedFileCount,
        },
      };
      await this.store.complete(
        scan.id,
        findings,
        this.reports.engine,
        content,
      );
    } catch (error) {
      this.logError(error);
      const message =
        error instanceof RepositoryReadError || error instanceof DependencyScanError
          ? error.message
          : "Scan could not be completed.";
      await this.store.update(scan.id, "failed", 0, "Failed", message);
    }
  }
}
