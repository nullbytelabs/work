// Flat ESLint config (ESLint 10 + typescript-eslint).
// tsc handles type errors; ESLint covers code-quality rules. We use the
// non-type-checked `recommended` preset to keep linting fast (no type info).
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["node_modules/", "dist/"] },
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
