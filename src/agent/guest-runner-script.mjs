/**
 * In-guest Pi runner wrapper (staged onto the shared /workspace mount and run by
 * `GuestPiRunner` via `target.run(...)` inside the sandbox).
 *
 * It is a standalone `.mjs` — NOT part of the TypeScript program — because it
 * executes in a *separate Node process inside the guest VM*, where it resolves
 * `@earendil-works/pi-coding-agent` from the guest's own module path (installed
 * in-guest by `GuestPiRunner` before this runs). It registers a custom
 * OpenAI-compatible provider, runs one prompt with Pi's full toolset rooted at
 * the workspace (`cwd`), and returns the final assistant text.
 *
 * Contract (kept dead simple so the host side is testable without a VM):
 *   argv[2] = path to a request JSON  { system, prompt, cwd, model: { baseUrl,
 *             model, maxTokens?, temperature? }, keyEnv }
 *   argv[3] = path to write a result JSON { text, finishReason?, usage? } | { error }
 *             where usage = { inputTokens, outputTokens, cacheReadTokens?,
 *             cacheCreationTokens?, requests? } — cumulative over the whole loop.
 * The model API key is NEVER in the request file: it is read from `process.env[keyEnv]`,
 * which Gondolin populates with a placeholder and swaps into the outbound
 * Authorization header host-side (the real key never enters the guest).
 */
import { readFile, writeFile, lstat, unlink } from "node:fs/promises";
import { createRequire } from "node:module";

const PI_PACKAGE = "@earendil-works/pi-coding-agent";
const PROVIDER_NAME = "work-custom";

async function loadPi() {
  // Resolve the package from the install dir next to this script (GuestPiRunner
  // installs it into the staging dir before invoking us), then fall back to the
  // default resolution path.
  try {
    const require = createRequire(import.meta.url);
    return await import(require.resolve(PI_PACKAGE));
  } catch {
    return await import(PI_PACKAGE);
  }
}

async function main() {
  const [, , requestPath, resultPath] = process.argv;
  if (!requestPath || !resultPath) {
    throw new Error("usage: guest-runner-script.mjs <request.json> <result.json>");
  }

  const req = JSON.parse(await readFile(requestPath, "utf-8"));
  const model = req.model ?? {};
  const apiKey = process.env[req.keyEnv ?? "PI_WF_MODEL_KEY"] ?? "";
  // The agent operates in the job's workspace (the /workspace mount) with the
  // full toolset rooted there — it reads/edits the real checkout directly.
  const cwd = req.cwd ?? process.cwd();

  let pi;
  try {
    pi = await loadPi();
  } catch (err) {
    throw new Error(
      `${PI_PACKAGE} could not be loaded inside the sandbox guest. ` +
        `Underlying: ${err?.message ?? err}`,
      { cause: err },
    );
  }

  const providerConfig = {
    name: PROVIDER_NAME,
    baseUrl: model.baseUrl,
    apiKey,
    api: "openai-completions",
    authHeader: true,
    models: [
      {
        id: model.model,
        name: model.model,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: model.maxTokens ?? 4096,
      },
    ],
  };

  const authStorage = pi.AuthStorage.inMemory();
  const modelRegistry = pi.ModelRegistry.inMemory(authStorage);
  modelRegistry.registerProvider(PROVIDER_NAME, providerConfig);

  const settingsManager = pi.SettingsManager.inMemory();
  const sessionManager = pi.SessionManager.inMemory();
  const resourceLoader = new pi.DefaultResourceLoader({
    cwd,
    agentDir: cwd,
    settingsManager,
    extensionFactories: [(api) => api.registerProvider(PROVIDER_NAME, providerConfig)],
    // Only override the system prompt when one was supplied. When omitted (the
    // `work/agent` primitive never sets it) → let the loader discover the persona
    // from the checkout (`.pi/`, `AGENTS.md`).
    ...(typeof req.system === "string" ? { systemPromptOverride: () => req.system } : {}),
  });
  await resourceLoader.reload();

  const selected = modelRegistry.find(PROVIDER_NAME, model.model);
  if (!selected) throw new Error(`could not resolve model "${model.model}" from the registered provider`);

  const { session } = await pi.createAgentSession({
    cwd,
    authStorage,
    modelRegistry,
    model: selected,
    resourceLoader,
    sessionManager,
    settingsManager,
  });

  await session.prompt(req.prompt);

  let lastAssistant;
  for (const msg of session.messages) if (msg.role === "assistant") lastAssistant = msg;
  if (!lastAssistant) throw new Error("agent produced no assistant message");
  const text = (lastAssistant.content ?? [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
  const finishReason = lastAssistant.stopReason;

  // Cumulative token usage across the whole loop — Pi's session aggregates every
  // model call. Optional-chained so an older Pi without getSessionStats degrades to
  // "no usage" instead of crashing. Read before dispose (it reads session state).
  const stats = session.getSessionStats?.();
  const tokens = stats?.tokens;
  const usage = tokens
    ? {
        inputTokens: tokens.input,
        outputTokens: tokens.output,
        ...(tokens.cacheRead ? { cacheReadTokens: tokens.cacheRead } : {}),
        ...(tokens.cacheWrite ? { cacheCreationTokens: tokens.cacheWrite } : {}),
        ...(typeof stats.assistantMessages === "number" ? { requests: stats.assistantMessages } : {}),
      }
    : undefined;
  session.dispose?.();

  const result = { text };
  if (finishReason) result.finishReason = finishReason;
  if (usage) result.usage = usage;
  await writeResultFile(resultPath, JSON.stringify(result));
}

// The host removed this path before the run and expects us to create a regular
// file. If a symlink exists here, a prompt-injected agent planted it (during the
// session, with the full toolset over the shared mount) to redirect our write out
// of the workspace and overwrite a host file. Remove the link itself (never its
// target) before writing a fresh regular file.
async function writeResultFile(path, data) {
  try {
    const st = await lstat(path);
    if (st.isSymbolicLink()) await unlink(path);
  } catch {
    /* nothing at the path — fine */
  }
  await writeFile(path, data);
}

main().catch(async (err) => {
  const resultPath = process.argv[3];
  const payload = JSON.stringify({ error: err?.message ?? String(err) });
  if (resultPath) await writeResultFile(resultPath, payload).catch(() => {});
  process.stderr.write((err?.message ?? String(err)) + "\n");
  process.exit(1);
});
