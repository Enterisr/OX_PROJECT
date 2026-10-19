import { readFile } from "node:fs/promises";
import Fastify, { type FastifyError } from "fastify";
import type {
  ReportBuilder,
  RepositoryReader,
  Scanner,
  ScanStore,
} from "./domain.js";
import { ScanOrchestrator } from "./orchestrator.js";
import { normalizeRepositoryUrl } from "./repository-url.js";

const idSchema = {
  type: "object",
  required: ["id"],
  additionalProperties: false,
  properties: {
    id: {
      type: "string",
      pattern: "^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$",
    },
  },
};

export function createApp(
  store: ScanStore,
  scanner: Scanner,
  reports: ReportBuilder,
  repositories: RepositoryReader,
) {
  const app = Fastify({
    logger: true,
    bodyLimit: 16_384,
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false } },
  });
  const orchestrator = new ScanOrchestrator(
    store,
    repositories,
    scanner,
    reports,
    (error) => app.log.error(error),
  );

  app.addHook("onSend", async (_request, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header(
      "Content-Security-Policy",
      "default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    );
    reply.header("Cache-Control", "no-store");
  });
  //static files
  for (const [route, filename, contentType] of [
    ["/", "index.html", "text/html; charset=utf-8"],
    ["/app.js", "app.js", "text/javascript; charset=utf-8"],
    ["/styles.css", "styles.css", "text/css; charset=utf-8"],
  ]) {
    app.get(route, async (_request, reply) =>
      reply
        .type(contentType)
        .send(
          await readFile(new URL(`../public/${filename}`, import.meta.url)),
        ),
    );
  }

  app.post<{ Body: { repositoryUrl: string; commitSha?: string } }>(
    "/scans",
    {
      schema: {
        body: {
          type: "object",
          required: ["repositoryUrl"],
          additionalProperties: false,
          properties: {
            repositoryUrl: { type: "string", maxLength: 2048 },
            commitSha: { type: "string", pattern: "^[a-fA-F0-9]{40}$" },
          },
        },
      },
    },
    async (request, reply) => {
      const repositoryUrl = normalizeRepositoryUrl(request.body.repositoryUrl);
      if (!repositoryUrl)
        return reply
          .code(400)
          .send({
            error:
              "Enter a GitHub repository URL, such as https://github.com/owner/repo.",
          });
      const scan = await store.create(repositoryUrl);
      orchestrator.enqueue(scan, request.body.commitSha?.toLowerCase());
      return reply
        .code(202)
        .header("Location", `/scans/${scan.id}`)
        .send({ scanId: scan.id });
    },
  );

  app.get<{ Params: { id: string } }>(
    "/scans/:id",
    { schema: { params: idSchema } },
    async (request, reply) => {
      const scan = await store.get(request.params.id);
      return scan ?? reply.code(404).send({ error: "Scan not found." });
    },
  );

  app.get<{ Params: { id: string } }>(
    "/scans/:id/results",
    { schema: { params: idSchema } },
    async (request, reply) => {
      const scan = await store.get(request.params.id);
      if (!scan) return reply.code(404).send({ error: "Scan not found." });
      if (scan.status !== "completed")
        return reply
          .code(409)
          .send({
            error: "Scan has no completed results.",
            status: scan.status,
          });
      const report = await store.getReport(scan.id);
      if (!report)
        return reply
          .code(500)
          .send({ error: "Completed report is unavailable." });
      return report;
    },
  );

  app.setErrorHandler<FastifyError>((error, request, reply) => {
    if (error.validation)
      return reply.code(400).send({ error: "Invalid request." });
    if (error.statusCode && error.statusCode < 500) {
      return reply.code(error.statusCode).send({ error: "Invalid request." });
    }
    request.log.error(error);
    return reply.code(500).send({ error: "Unable to process the request." });
  });
  app.addHook("onClose", () => orchestrator.drain());
  return { app, orchestrator };
}
