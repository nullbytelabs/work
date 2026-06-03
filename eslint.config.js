// Flat ESLint config (ESLint 10 + typescript-eslint).
// tsc handles type errors; ESLint covers code-quality rules. We use the
// non-type-checked `recommended` preset to keep linting fast (no type info).
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // `dist/` only matches a top-level dir; `**/dist/` also catches nested build
  // output. `docs-site/` is an isolated VitePress project (own deps, own build
  // + deploy in .github/workflows/docs.yml) — not part of the engine's lint.
  { ignores: ["node_modules/", "**/dist/", "docs-site/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Everything here runs on Node (the CLI, the shim, the tests).
    files: ["**/*.{js,mjs,ts}"],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    files: ["src/**/*.ts", "test/**/*.ts"],
    rules: {
      // Allow intentionally-unused names when prefixed with `_` (e.g. unused
      // hook args like `_jobId`).
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
);
