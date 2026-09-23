import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    ".tools/**",
    ".tmp/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Agent worktrees are whole checkouts nested in this one, with their own
    // .next build output; they are linted in their own checkout, not here.
    ".claude/**",
  ]),
]);

export default eslintConfig;
