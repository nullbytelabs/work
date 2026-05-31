import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PiAgentRunner } from "../src/agent/pi-runner.ts";
import { UserFacingError } from "../src/errors.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// The Pi SDK is an optional dependency; skip the SDK-dependent test if it's
// not installed (e.g. `npm ci --omit=optional`).
const HAS_PI = existsSync(resolve(REPO, "node_modules/@earendil-works/pi-coding-agent"));

describe("PiAgentRunner", () => {
  it("throws a clear error when no model is configured (no SDK needed)", async () => {
    await assert.rejects(
      () => new PiAgentRunner().run({ system: "s", prompt: "p" }),
      (e) => e instanceof UserFacingError && /needs a model/.test(e.message),
    );
  });

  // This exercises the REAL runner offline: it must register the provider and
  // create the session successfully (the part that previously threw
  // "apiKey is required"), then fail cleanly when the endpoint is unreachable.
  it(
    "registers the provider + session, then fails cleanly on an unreachable endpoint",
    { skip: HAS_PI ? false : "@earendil-works/pi-coding-agent not installed" },
    async () => {
      await assert.rejects(
        () =>
          new PiAgentRunner().run({
            system: "You summarize.",
            prompt: "Summarize: hello.",
            model: { baseUrl: "http://127.0.0.1:9/v1", apiKey: "fw_test", model: "test/model" },
          }),
        (e) => e instanceof UserFacingError && /(did not complete|stopReason=error)/.test(e.message),
      );
    },
  );
});
