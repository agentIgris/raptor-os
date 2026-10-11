/*
 * CSS side-effect imports.
 *
 * TypeScript cannot resolve `.css` imports on its own, and the compiler is a
 * release gate (ADR-0012), so the declaration has to exist somewhere rather
 * than the import being quietly typed as `any`.
 */

declare module "*.css";