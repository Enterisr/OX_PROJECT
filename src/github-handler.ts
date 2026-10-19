import { gunzipSync } from "node:zlib";
import tar from "tar-stream";
import type {
  ProgressCallback,
  RepositoryReader,
  RepositorySnapshot,
} from "./domain.js";
import { normalizeRepositoryUrl } from "./repository-url.js";

const MB = 1024 * 1024;
const MAX_COMPRESSED_BYTES = 10 * MB;
const MAX_ARCHIVE_BYTES = 20 * MB;
const MAX_FILE_BYTES = MB;
const MAX_TEXT_BYTES = 5 * MB;
const MAX_ENTRIES = 2000;

export class RepositoryReadError extends Error {}

async function readLimited(response: Response, limit: number): Promise<Buffer> {
  if (!response.body)
    throw new RepositoryReadError("GitHub returned an empty response.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return Buffer.concat(chunks, size);
      size += value.byteLength;
      if (size > limit)
        throw new RepositoryReadError(
          "Repository exceeds the download size limit.",
        );
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function readArchive(
  compressed: Buffer,
): Promise<Pick<RepositorySnapshot, "files" | "skippedFileCount">> {
  let archive: Buffer;
  try {
    archive = gunzipSync(compressed, { maxOutputLength: MAX_ARCHIVE_BYTES });
  } catch {
    throw new RepositoryReadError(
      "Repository archive is invalid or exceeds 20 MB.",
    );
  }

  const files: RepositorySnapshot["files"] = [];
  let skippedFileCount = 0;
  let textBytes = 0;
  let entryCount = 0;
  let root: string | undefined;
  const seen = new Set<string>();
  const decoder = new TextDecoder("utf-8", { fatal: true });

  await new Promise<void>((resolve, reject) => {
    const extract = tar.extract();
    extract.on("error", reject);
    extract.on("finish", resolve);
    extract.on("entry", (header, stream, next) => {
      stream.on("error", reject);
      try {
        if (++entryCount > MAX_ENTRIES)
          throw new RepositoryReadError(
            "Repository exceeds the file count limit.",
          );
        const parts = header.name.replace(/\/$/, "").split("/");
        if (
          header.name.includes("\\") ||
          /[\x00-\x1f]/.test(header.name) ||
          parts.some((part) => !part || part === "." || part === "..")
        ) {
          throw new RepositoryReadError(
            "Repository archive contains an invalid path.",
          );
        }
        root ??= parts[0];
        if (parts[0] !== root)
          throw new RepositoryReadError(
            "Repository archive contains an invalid root.",
          );
        const path = parts.slice(1).join("/");
        const toInclude =
          header.type === "file" &&
          path &&
          (header.size ?? 0) <= MAX_FILE_BYTES;
        if (header.type !== "directory" && !toInclude) skippedFileCount++;
        const chunks: Buffer[] = [];
        if (toInclude)
          stream.on("data", (chunk) => {
            chunks.push(chunk as Buffer);
          });
        stream.on("end", () => {
          try {
            if (toInclude) {
              if (seen.has(path))
                throw new RepositoryReadError(
                  "Repository archive contains duplicate file paths.",
                );
              seen.add(path);
              const bytes = Buffer.concat(chunks);
              let content: string | undefined;
              if (!bytes.includes(0)) {
                try {
                  content = decoder.decode(bytes);
                } catch {
                  /* Skip non-UTF-8 files. */
                }
              }
              if (content === undefined) skippedFileCount++;
              else {
                textBytes += bytes.length;
                if (textBytes > MAX_TEXT_BYTES)
                  throw new RepositoryReadError(
                    "Repository exceeds the 5 MB text limit.",
                  );
                files.push({ path, content });
              }
            }
            next();
          } catch (error) {
            extract.destroy(error as Error);
          }
        });
        stream.resume();
      } catch (error) {
        extract.destroy(error as Error);
      }
    });
    extract.end(archive);
  });
  return { files, skippedFileCount };
}

export class PublicGitHubReader implements RepositoryReader {
  constructor(private readonly fetcher: typeof fetch = fetch) {}

  async read(
    repositoryUrl: string,
    onProgress: ProgressCallback,
    requestedCommitSha?: string,
  ): Promise<RepositorySnapshot> {
    if (requestedCommitSha !== undefined && !/^[a-fA-F0-9]{40}$/.test(requestedCommitSha))
      throw new RepositoryReadError("commitSha must be a full 40-character hexadecimal SHA.");
    requestedCommitSha = requestedCommitSha?.toLowerCase();
    const normalized = normalizeRepositoryUrl(repositoryUrl);
    if (!normalized)
      throw new RepositoryReadError(
        "Only public github.com repository URLs are supported.",
      );
    const [, owner, repo] = new URL(normalized).pathname.split("/");
    const apiUrl = `https://api.github.com/repos/${owner}/${repo}`;
    const signal = AbortSignal.timeout(60_000);
    try {
      await onProgress(15, "Checking public repository");
      const metadataResponse = await this.request(apiUrl, signal);
      const metadata = JSON.parse(
        (await readLimited(metadataResponse, MB)).toString("utf8"),
      );
      if (metadata.private !== false || metadata.visibility !== "public") {
        throw new RepositoryReadError(
          "Only public repositories are supported.",
        );
      }
      if (
        typeof metadata.default_branch !== "string" ||
        !metadata.default_branch
      ) {
        throw new RepositoryReadError("Repository has no default branch.");
      }
      const commitResponse = await this.request(
        `${apiUrl}/commits/${encodeURIComponent(requestedCommitSha ?? metadata.default_branch)}`,
        signal,
        "application/vnd.github.sha",
      );
      const commitSha = (await readLimited(commitResponse, 128))
        .toString("utf8")
        .trim();
      if (!/^[a-f0-9]{40}$/.test(commitSha))
        throw new RepositoryReadError("GitHub returned an invalid commit.");
      if (requestedCommitSha && commitSha !== requestedCommitSha)
        throw new RepositoryReadError("GitHub returned a different commit than requested.");

      await onProgress(35, "Reading repository files");
      const response = await this.request(
        `https://codeload.github.com/${owner}/${repo}/tar.gz/${commitSha}`,
        signal,
      );
      const snapshot = await readArchive(
        await readLimited(response, MAX_COMPRESSED_BYTES),
      );
      await onProgress(55, `Read ${snapshot.files.length} text files`);
      return {
        repositoryUrl: normalized,
        defaultBranch: metadata.default_branch,
        commitSha,
        ...snapshot,
      };
    } catch (error) {
      if (error instanceof RepositoryReadError) throw error;
      if (signal.aborted)
        throw new RepositoryReadError("GitHub repository read timed out.");
      throw new RepositoryReadError(
        "Could not read the GitHub repository. Try again.",
      );
    }
  }

  private async request(
    url: string,
    signal: AbortSignal,
    accept = "application/vnd.github+json",
  ) {
    const response = await this.fetcher(url, {
      signal,
      redirect: "manual",
      credentials: "omit",
      headers: {
        Accept: accept,
        "User-Agent": "security-scan-review",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (response.ok) return response;
    await response.body?.cancel();
    if (response.status === 404)
      throw new RepositoryReadError("Repository not found or not public.");
    if (
      response.status === 429 ||
      (response.status === 403 &&
        response.headers.get("x-ratelimit-remaining") === "0")
    ) {
      throw new RepositoryReadError(
        "GitHub rate limit reached. Try again later.",
      );
    }
    if (response.status >= 300 && response.status < 400)
      throw new RepositoryReadError(
        "Repository moved. Use its current GitHub URL.",
      );
    if (response.status === 409)
      throw new RepositoryReadError("Repository is empty.");
    throw new RepositoryReadError("GitHub could not read this repository.");
  }
}
