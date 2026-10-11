// Tailwind v4 PostCSS plugin.
//
// NOTE ON THE FILE NAME: this is `postcss.config.js` and NOT
// `postcss.config.mjs`. The repository ESLint config ignores `**/*.config.js`
// but its type-aware parser has no project for `.mjs` files, so an `.mjs`
// config is a hard lint failure ("was not found by the project service"). This
// package also deliberately does not set `"type": "module"`, so this file is
// CommonJS — which is exactly what PostCSS expects.

module.exports = {
  plugins: {
    "@tailwindcss/postcss": {},
  },
};