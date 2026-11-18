// @ts-check
import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig(
  { ignores: ["**/node_modules/", "**/dist/", "**/.vercel/", "**/coverage/"] },
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true }],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", ignoreRestSiblings: true },
      ],
    },
  },
  {
    // The Slack adapter talks to the API only through its route and the shared contract
    // (decision 43). compose.ts is the one place that wires them together.
    files: ["apps/api/src/slack/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex: "(^|/)api/",
              message: "The Slack adapter may not import the API's code. Use @hippidy/contracts.",
            },
            {
              regex: "(^|/)compose\\.ts$",
              message: "Only tests may import the composition root.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["apps/api/src/slack/**/*.test.ts"],
    rules: { "no-restricted-imports": "off" },
  },
  {
    files: ["**/*.js"],
    extends: [tseslint.configs.disableTypeChecked],
  },
  prettier,
);
