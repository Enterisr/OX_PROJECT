import pg from "pg";
import { createApp } from "./app.js";
import { BasicScanner } from "./scanner.js";
import { DependencyScanner } from "./dependency-scanner.js";
import { BasicReportBuilder } from "./report.js";
import { PostgresScanStore } from "./store.js";
import { PublicGitHubReader } from "./github-handler.js";

if (!process.env.DATABASE_URL)
  throw new Error("DATABASE_URL is required. Copy .env.example to .env first.");
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 5000,
});
pool.on("error", (error) =>
  console.error("PostgreSQL connection error:", error.message),
);
const store = new PostgresScanStore(pool);
const { app, orchestrator } = createApp(
  store,
  {
    async scan(repository, progress) {
      const sourceFindings = await new BasicScanner().scan(repository, progress);
      const dependencyFindings = await new DependencyScanner().scan(repository, progress);
      return [...sourceFindings, ...dependencyFindings];
    },
  },
  new BasicReportBuilder(),
  new PublicGitHubReader(),
);
app.addHook("onClose", async () => {
  await orchestrator.drain();
  await pool.end();
});

try {
  await store.failInterruptedScans();
  await app.listen({
    host: process.env.HOST ?? "127.0.0.1",
    port: Number(process.env.PORT ?? 3000),
  });
} catch (error) {
  app.log.error(error);
  await app.close();
  process.exitCode = 1;
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    void app.close().catch((error) => {
      app.log.error(error);
      process.exitCode = 1;
    });
  });
}
