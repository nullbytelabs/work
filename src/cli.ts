/**
 * pi-workflows CLI (Phase 1).
 *
 *   pi-workflows <workflow.yaml> [--workdir <dir>] [--quiet]
 *
 * Pipeline: read file -> parseWorkflow -> compile -> DirectRuntime.run.
 * Streams step output live and exits non-zero if any job fails.
 */
import { readFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseWorkflow, WorkflowParseError } from "./spec/index.ts";
import { compile, WorkflowCompileError } from "./compiler/index.ts";
import { DirectRuntime } from "./runtime/index.ts";
import { UserFacingError } from "./errors.ts";

interface CliArgs {
  file: string;
  workdir?: string;
  quiet: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  let file: string | undefined;
  let workdir: string | undefined;
  let quiet = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--workdir") {
      workdir = argv[++i];
      if (!workdir) fail("--workdir requires a directory path");
    } else if (arg === "--quiet") {
      quiet = true;
    } else if (arg === "-h" || arg === "--help") {
      printUsage();
      process.exit(0);
    } else if (arg.startsWith("-")) {
      fail(`unknown flag: ${arg}`);
    } else if (!file) {
      file = arg;
    } else {
      fail(`unexpected argument: ${arg}`);
    }
  }

  if (!file) {
    printUsage();
    process.exit(2);
  }
  return { file, workdir, quiet };
}

function printUsage(): void {
  process.stderr.write(
    "Usage: pi-workflows <workflow.yaml> [--workdir <dir>] [--quiet]\n",
  );
}

function fail(msg: string): never {
  process.stderr.write(`pi-workflows: ${msg}\n`);
  process.exit(2);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  let yamlText: string;
  try {
    yamlText = await readFile(resolve(args.file), "utf-8");
  } catch {
    fail(`cannot read workflow file: ${args.file}`);
  }

  let plan;
  try {
    const spec = parseWorkflow(yamlText);
    plan = compile(spec);
  } catch (err) {
    if (err instanceof WorkflowParseError || err instanceof WorkflowCompileError) {
      fail(err.message);
    }
    throw err;
  }

  const workRoot = args.workdir
    ? resolve(args.workdir)
    : await mkdtemp(join(tmpdir(), "pi-workflows-"));

  const out = process.stdout;
  if (!args.quiet) out.write(`workflow: ${plan.name}\n`);

  const runtime = new DirectRuntime();
  const result = await runtime.run(plan, {
    workRoot,
    hooks: args.quiet
      ? undefined
      : {
          onJobStart: (jobId) => out.write(`\n[job: ${jobId}]\n`),
          onStepStart: (_jobId, stepName) => out.write(`  > ${stepName}\n`),
          onOutput: (_jobId, _stepName, chunk) => {
            const prefix = chunk.stream === "stderr" ? "    ! " : "    ";
            for (const line of chunk.text.replace(/\n$/, "").split("\n")) {
              out.write(`${prefix}${line}\n`);
            }
          },
          onStepEnd: (_jobId, step) => {
            const mark = step.status === "success" ? "ok" : step.status;
            out.write(`    (${mark}, exit ${step.exitCode})\n`);
          },
        },
  });

  if (!args.quiet) out.write(`\nresult: ${result.status}\n`);
  process.exit(result.status === "success" ? 0 : 1);
}

main().catch((err) => {
  if (err instanceof UserFacingError) {
    process.stderr.write(`pi-workflows: ${err.message}\n`);
  } else {
    process.stderr.write(`pi-workflows: unexpected error: ${(err as Error).stack ?? err}\n`);
  }
  process.exit(1);
});
