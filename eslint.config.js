// @ts-check
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

/**
 * Flat ESLint config.
 *
 * The legacy repository paired ESLint 8 with `eslint-config-next` 15 and then disabled
 * linting at build time, which made the whole check decorative. Here the version pair
 * is matched, the config is the flat format ESLint 10 requires, and these rules are
 * enforced rather than decorative.
 */
export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.next/**",
      "**/.turbo/**",
      "**/coverage/**",
      "**/.data/**",
      "AUDIT/**",
      "**/*.config.js",
      "**/vitest.config.ts",
      "**/drizzle.config.ts",
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,

  {
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // The legacy app compiled every console.* out of production, which destroyed all
      // diagnostic output. Structured logging is the supported path instead.
      "no-console": ["error", { allow: ["warn", "error"] }],
      "no-debugger": "error",

      eqeqeq: ["error", "always", { null: "ignore" }],
      "no-implicit-coercion": "error",
      "prefer-const": "error",
      "no-var": "error",

      // Money must never touch a float.
      "no-restricted-globals": [
        "error",
        { name: "parseFloat", message: "Use exact decimal parsing; floats cannot represent money." },
        { name: "parseInt", message: "Use explicit integer parsing with a radix." },
      ],

      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/consistent-type-imports": ["error", { prefer: "type-imports" }],
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/require-await": "error",
      "@typescript-eslint/no-unnecessary-condition": "off",
    },
  },

  // Tests legitimately produce loose values and assert on thrown shapes.
  {
    files: ["**/*.test.ts", "**/*.test.tsx"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/unbound-method": "off",
      "@typescript-eslint/no-unnecessary-type-assertion": "off",
      // One test deliberately rejects with a non-Error to prove resilience.
      "@typescript-eslint/prefer-promise-reject-errors": "off",
      "no-restricted-globals": "off",
    },
  },

  // Migration SQL and seed scripts are allowed to be looser.
  {
    files: ["**/seed.ts", "**/migrate.ts"],
    rules: { "@typescript-eslint/no-floating-promises": "off" },
  },

  // The local scripts are CLI TOOLS, and they are linted on their own terms.
  //
  // They were invisible to the linter for a long time: the project service
  // could not load a file that no tsconfig included, so every script in this
  // directory produced a PARSING error and the repo-wide lint was red.
  // `scripts/tsconfig.json` gives the linter a project to load them from, and
  // the rules below are the ones that make sense for a script.
  {
    files: ["scripts/**/*.mjs", "scripts/**/*.ts"],
    rules: {
      // A SCRIPT'S OUTPUT IS ITS INTERFACE. `console.log` is how a setup
      // script reports what it did; the rule exists so that application code
      // emits structured logs instead of loose lines, and a script has no
      // logger to emit them with.
      "no-console": "off",
      // These are plain Node ESM files with no type annotations, so every
      // value the type-aware rules see is `any`. Flagging that would be
      // flagging the absence of a type system rather than a defect.
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-unnecessary-condition": "off",
      // The money rule stays — but a script parsing a millisecond counter is
      // not money, and `parseInt` with an explicit radix is the correct call
      // where it is used.
      "no-restricted-globals": "off",
    },
  },

  // Payload-generated migrations: the runner calls `up({ db, payload, req })`
  // positionally, so `payload`/`req` are unused by every migration that only
  // needs `db`. Generated on each `migrate:create`; hand-editing them per file
  // would be reverted by the next generation.
  {
    files: ["packages/cms/src/migrations/**/*.ts"],
    rules: { "@typescript-eslint/no-unused-vars": "off" },
  },
);