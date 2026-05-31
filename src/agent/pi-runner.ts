/**
 * Pi-SDK-backed AgentRunner.
 *
 * Runs a SINGLE no-tools prompt through the `@earendil-works/pi-coding-agent`
 * SDK and returns the final assistant text. This is the "full Pi-SDK runner"
 * the `OpenAiAgentRunner` doc comment anticipated: same OpenAI-compatible
 * (`openai-completions`) dialect, but driven through Pi's agent session so the
 * model/provider config carries over.
 *
 * The SDK is an OPTIONAL dependency. CI installs with `--omit=optional`, so we
 * must NOT statically `import` the package — that would make `tsc` (and the
 * build) require it on disk. Instead we lazy-load it via a NON-LITERAL dynamic
 * import and cast the result to small LOCAL structural interfaces that mirror
 * only the bits we call. Those interfaces are derived from the package's own
 * `.d.ts` (see the runner's accompanying report for the exact declarations).
 *
 * Provider/auth handling is fully in-memory: a custom `openai-completions`
 * provider is registered programmatically inside an extension factory, the API
 * key is supplied as a RUNTIME (non-persisted) override, and session/settings
 * managers are the in-memory variants. Nothing is written to disk and the key
 * never touches `auth.json`.
 */
import { UserFacingError } from "../errors.ts";
import type { ResolvedModel } from "../config/index.ts";
import type { AgentRequest, AgentResult, AgentRunner } from "./index.ts";

// --- Minimal structural views of the SDK surface we touch -------------------
// Based on @earendil-works/pi-coding-agent@0.78.0 .d.ts:
//   core/model-registry.d.ts, core/auth-storage.d.ts, core/session-manager.d.ts,
//   core/settings-manager.d.ts, core/resource-loader.d.ts, core/sdk.d.ts,
//   core/agent-session.d.ts, and (transitively) @earendil-works/pi-ai types.d.ts.

/** Provider config accepted by `pi.registerProvider` (ProviderConfig in extensions/types.d.ts). */
interface PiProviderModelConfig {
  id: string;
  name: string;
  reasoning: boolean;
  input: ("text" | "image")[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
}
interface PiProviderConfig {
  name?: string;
  baseUrl?: string;
  apiKey?: string;
  api?: string;
  authHeader?: boolean;
  headers?: Record<string, string>;
  models?: PiProviderModelConfig[];
}

/** Subset of ExtensionAPI (extensions/types.d.ts) we use inside the factory. */
interface PiExtensionApi {
  registerProvider(name: string, config: PiProviderConfig): void;
}
/** ExtensionFactory = (pi: ExtensionAPI) => void | Promise<void>. */
type PiExtensionFactory = (pi: PiExtensionApi) => void | Promise<void>;

/** Opaque model handle (Model<Api> in pi-ai); we only pass it back to the SDK. */
type PiModel = unknown;

/** ModelRegistry (core/model-registry.d.ts): only `find` + the auth storage handle. */
interface PiModelRegistry {
  authStorage: PiAuthStorage;
  find(provider: string, modelId: string): PiModel | undefined;
  registerProvider(providerName: string, config: PiProviderConfig): void;
}
interface PiModelRegistryStatic {
  inMemory(authStorage: PiAuthStorage): PiModelRegistry;
}

/** AuthStorage (core/auth-storage.d.ts): in-memory ctor + runtime (non-persisted) key. */
interface PiAuthStorage {
  setRuntimeApiKey(provider: string, apiKey: string): void;
}
interface PiAuthStorageStatic {
  inMemory(): PiAuthStorage;
}

/** SessionManager / SettingsManager (core/*-manager.d.ts): in-memory factories. */
interface PiSessionManagerStatic {
  inMemory(cwd?: string): unknown;
}
interface PiSettingsManagerStatic {
  inMemory(settings?: unknown): unknown;
}

/** DefaultResourceLoader (core/resource-loader.d.ts). */
interface PiResourceLoader {
  reload(): Promise<void>;
}
interface PiDefaultResourceLoaderOptions {
  cwd: string;
  agentDir: string;
  settingsManager?: unknown;
  extensionFactories?: PiExtensionFactory[];
  systemPromptOverride?: (base: string | undefined) => string | undefined;
}
type PiResourceLoaderCtor = new (options: PiDefaultResourceLoaderOptions) => PiResourceLoader;

/** Text content block (pi-ai types.d.ts: TextContent). */
interface PiTextContent {
  type: "text";
  text: string;
}
/** AssistantMessage (pi-ai types.d.ts): role + content blocks + stopReason. */
interface PiAssistantMessage {
  role: "assistant";
  content: Array<{ type: string } & Partial<PiTextContent>>;
  stopReason?: string;
}
type PiAgentMessage = { role: string } & Partial<PiAssistantMessage>;

/** AgentSession (core/agent-session.d.ts): the slice we read after a prompt. */
interface PiAgentSession {
  prompt(text: string): Promise<void>;
  readonly messages: PiAgentMessage[];
  dispose(): void;
}

/** createAgentSession options/result (core/sdk.d.ts). */
interface PiCreateAgentSessionOptions {
  cwd?: string;
  authStorage?: PiAuthStorage;
  modelRegistry?: PiModelRegistry;
  model?: PiModel;
  noTools?: "all" | "builtin";
  resourceLoader?: PiResourceLoader;
  sessionManager?: unknown;
  settingsManager?: unknown;
}
interface PiCreateAgentSessionResult {
  session: PiAgentSession;
}

/** The structural shape we cast the dynamic-import namespace to. */
interface PiSdkModule {
  AuthStorage: PiAuthStorageStatic;
  ModelRegistry: PiModelRegistryStatic;
  SessionManager: PiSessionManagerStatic;
  SettingsManager: PiSettingsManagerStatic;
  DefaultResourceLoader: PiResourceLoaderCtor;
  createAgentSession(options?: PiCreateAgentSessionOptions): Promise<PiCreateAgentSessionResult>;
}

const PI_PACKAGE = "@earendil-works/pi-coding-agent";
/** Synthetic provider name for the registered custom provider. */
const PROVIDER_NAME = "pi-workflows-custom";

/**
 * Runs one prompt through the Pi coding-agent SDK (no tools) and returns the
 * final assistant text. The SDK is loaded lazily so typecheck/build don't need
 * the optional dependency present.
 */
export class PiAgentRunner implements AgentRunner {
  async run(req: AgentRequest): Promise<AgentResult> {
    if (!req.model) {
      throw new UserFacingError(
        "agent step needs a model — provide a config (--config) with providers/models and a defaultModel, or set with.model",
      );
    }
    const model: ResolvedModel = req.model;

    // Lazy, non-literal dynamic import so `tsc` doesn't require the optional dep.
    const specifier = PI_PACKAGE;
    let pi: PiSdkModule;
    try {
      pi = (await import(specifier)) as unknown as PiSdkModule;
    } catch (err) {
      throw new UserFacingError(
        `agent/pi runner requires the optional dependency ${PI_PACKAGE} — ` +
          `npm install ${PI_PACKAGE} (it is omitted in --omit=optional installs). ` +
          `Underlying error: ${(err as Error).message}`,
      );
    }

    // In-memory auth + registry; runtime (non-persisted) API key for our provider.
    const authStorage = pi.AuthStorage.inMemory();
    authStorage.setRuntimeApiKey(PROVIDER_NAME, model.apiKey);
    const modelRegistry = pi.ModelRegistry.inMemory(authStorage);

    // Custom OpenAI-compatible provider built from the resolved model.
    const providerConfig: PiProviderConfig = {
      name: PROVIDER_NAME,
      baseUrl: model.baseUrl,
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
          // maxTokens caps output tokens for this model entry.
          maxTokens: model.maxTokens ?? 4096,
        },
      ],
    };

    // Register via an extension factory (the documented programmatic path) so
    // the loader binds it during reload(); also register directly on the
    // registry so `find()` resolves the model before the session is created.
    const factory: PiExtensionFactory = (api) => {
      api.registerProvider(PROVIDER_NAME, providerConfig);
    };
    modelRegistry.registerProvider(PROVIDER_NAME, providerConfig);

    const settingsManager = pi.SettingsManager.inMemory();
    const sessionManager = pi.SessionManager.inMemory();

    const resourceLoader = new pi.DefaultResourceLoader({
      cwd: process.cwd(),
      agentDir: process.cwd(),
      settingsManager,
      extensionFactories: [factory],
      // Force our system prompt regardless of any discovered context/AGENTS files.
      systemPromptOverride: () => req.system,
    });
    await resourceLoader.reload();

    const selected = modelRegistry.find(PROVIDER_NAME, model.model);
    if (!selected) {
      throw new UserFacingError(
        `agent/pi runner could not resolve model "${model.model}" from the registered provider`,
      );
    }

    const { session } = await pi.createAgentSession({
      cwd: process.cwd(),
      authStorage,
      modelRegistry,
      model: selected,
      noTools: "all",
      resourceLoader,
      sessionManager,
      settingsManager,
    });

    try {
      // Resolves after the full run (including any auto-retries).
      await session.prompt(req.prompt);

      // Final assistant text = concatenated text blocks of the last assistant message.
      let lastAssistant: PiAgentMessage | undefined;
      for (const msg of session.messages) {
        if (msg.role === "assistant") lastAssistant = msg;
      }
      if (!lastAssistant) {
        throw new UserFacingError("agent/pi runner produced no assistant message");
      }

      const text = (lastAssistant.content ?? [])
        .filter((block): block is { type: string } & PiTextContent => block.type === "text")
        .map((block) => block.text)
        .join("");

      const result: AgentResult = { text };
      if (typeof lastAssistant.stopReason === "string") {
        result.finishReason = lastAssistant.stopReason;
      }
      return result;
    } finally {
      session.dispose();
    }
  }
}
