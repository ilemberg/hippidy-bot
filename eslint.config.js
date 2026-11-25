// @ts-check
import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig(
  {
    ignores: [
      "**/node_modules/",
      "**/dist/",
      "**/.vercel/",
      "**/coverage/",
      "**/.next/",
      "**/next-env.d.ts",
    ],
  },
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
    // (decision 43). compose.ts is the one place that wires them together; index.ts holds the
    // whole app. Static and dynamic imports of any of them, with any extension, are blocked.
    files: ["apps/api/src/slack/**/*.ts"],
    ignores: ["apps/api/src/slack/**/*.test.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex: String.raw`(^|/)((api|store)(/|$)|(compose|index)(\.[cm]?[jt]s)?$)`,
              message:
                "The Slack adapter may not import the API, its store, compose.ts or index.ts. Use @hippidy/contracts.",
            },
          ],
        },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector: String.raw`ImportExpression[source.value=/(^|\/)((api|store)(\/|$)|(compose|index)(\.[cm]?[jt]s)?$)/]`,
          message:
            "The Slack adapter may not import the API, its store, compose.ts or index.ts. Use @hippidy/contracts.",
        },
      ],
    },
  },
  {
    // The web app talks to the system only through the API's routes (decision 22): it imports
    // the shared contract, never the API's code.
    files: ["apps/web/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex: String.raw`(^|/)apps/api(/|$)|^@hippidy/api$|(^|/)api/src(/|$)`,
              message: "The web app may not import the API's code. Call it over HTTP.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["**/*.js"],
    extends: [tseslint.configs.disableTypeChecked],
  },
  prettier,
);
