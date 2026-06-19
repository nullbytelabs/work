/**
 * Playwright web-server launcher for the `work serve` console e2e tests.
 *
 * Boots a real `startWebServer` on a fixed loopback port over a throwaway
 * workspace seeded with a couple of trivial workflows (so the UI shell, nav, and
 * every route render), then prints the URL and parks. Playwright's `webServer`
 * config runs this, waits for the port, and tears it down after the run.
 *
 * No runs are ever dispatched by these tests — navigation is GET-only — so no
 * gondolin/QEMU is touched and the default engine (PGLite, in-process) suffices.
 */
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startWebServer, type WebServerHandle } from "../../src/web/index.ts";

const PORT = Number(process.env.WORK_WEB_E2E_PORT ?? 4399);

// Two trivial workflows so the Workflows list is non-empty and routable. These
// are config, not run data — the tests never assert on their contents.
const ECHO = `name: echo
jobs:
  say:
    runs-on: gondolin
    steps:
      - name: greet
        run: echo hello
`;

const NIGHTLY = `name: nightly
on:
  schedule:
    - cron: "0 0 * * *"
jobs:
  tick:
    runs-on: gondolin
    steps:
      - name: tick
        run: echo tick
`;

async function main() {
  const workspace = await mkdtemp(join(tmpdir(), "work-web-e2e-"));
  const wfDir = join(workspace, ".workflows");
  await mkdir(wfDir, { recursive: true });
  await writeFile(join(wfDir, "echo.yaml"), ECHO);
  await writeFile(join(wfDir, "nightly.yaml"), NIGHTLY);

  const server: WebServerHandle = await startWebServer({ workspace, port: PORT });

  const shutdown = async () => {
    try {
      await server.close();
    } finally {
      await rm(workspace, { recursive: true, force: true });
      process.exit(0);
    }
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Playwright waits on this line via the webServer.url health check.
  console.log(`work web console listening on ${server.url}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
