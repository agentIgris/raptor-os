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

  // Payload-generated migrations: the runner calls `up({ db, payload, req })`
  // positionally, so `payload`/`req` are unused by every migration that only
  // needs `db`. Generated on each `migrate:create`; hand-editing them per file
  // would be reverted by the next generation.
  {
    files: ["packages/cms/src/migrations/**/*.ts"],
    rules: { "@typescript-eslint/no-unused-vars": "off" },
  },
);