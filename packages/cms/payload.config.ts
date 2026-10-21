import path from "node:path";
import { fileURLToPath } from "node:url";
import { postgresAdapter } from "@payloadcms/db-postgres";
import { lexicalEditor } from "@payloadcms/richtext-lexical";
import { s3Storage } from "@payloadcms/storage-s3";
import { tlsOptionsForDatabaseUrl } from "@raptor/auth/config";
import { buildConfig } from "payload";

import { Operators } from "./src/collections/operators.js";
import { Media } from "./src/collections/media.js";
import { News } from "./src/collections/news.js";
import { Pages } from "./src/collections/pages.js";
import { Partners } from "./src/collections/partners.js";
import { Recruitment } from "./src/globals/recruitment.js";
import { SiteSettings } from "./src/globals/site-settings.js";

const filename = fileURLToPath(import.meta.url);
const dirname = path.dirname(filename);
const srcDir = path.resolve(dirname, "src");
// src -> cms -> packages -> the repository root.
const repoRoot = path.resolve(srcDir, "..", "..", "..");
const importMapFile = path.resolve(repoRoot, "apps", "web", "src", "app", "(payload)", "importMap.js");

/**
 * Payload CMS configuration for Raptor OS.
 *
 * WHAT THIS OWNS: publishable content (collections/globals added in Task 2)
 * in `cms_*` tables. WHAT IT NEVER TOUCHES: the 91 domain tables, Better Auth
 * identity, RLS policies. The adapter connects with the migration credential;
 * Task 2 cuts runtime over to the least-privilege `cms_app` role.
 *
 * `push: false` is load-bearing: Payload must never auto-apply schema on boot.
 * Schema changes go through `payload migrate:create` + `payload migrate`,
 * reviewed like any other migration.
 *
 * TLS goes through the same helper as every other pool in this repository
 * (`tlsOptionsForDatabaseUrl`): managed poolers present chains Node cannot
 * verify, and the `sslmode` query parameter is stripped because node-postgres
 * lets it override the explicit `ssl` object.
 *
 * Routes are `/cms-admin` + `/cms-api` because `/api/*` already belongs to
 * Better Auth and the health probes. The nonce CSP in `apps/web/src/proxy.ts`
 * already excludes `api/*`; the admin document route is covered by it.
 */
/**
 * sharp is optional at runtime, mandatory at build time.
 *
 * Image resizing/crops need it; plain reads and uploads of originals do not.
 * It is loaded with a bundler-ignored dynamic import because Next.js
 * externalises `sharp` out of serverless bundles (its own image optimizer
 * owns that copy) — a static import 500s every route that evaluates this
 * config on Vercel (proven in production logs). Locally and in CI the package
 * is installed, so crops work there; where it is absent (Vercel lambda),
 * uploads store originals and the admin warns instead of crashing.
 *
 * THE APP NEEDS IT, NOT JUST THIS PACKAGE. The import above is resolved by
 * the process that EVALUATES this config, and in a deployment that is the web
 * app — it is what mounts Payload. `packages/cms` having sharp is therefore
 * not enough: without sharp in `apps/web`'s own dependencies the bundler
 * cannot resolve the specifier, the dynamic import throws, the catch swallows
 * it, and Payload runs with image resizing switched off while the admin
 * console shows a warning that reads like a misconfiguration. Measured: the
 * admin rendered its media as a large placeholder icon with exactly that
 * warning in the log. `apps/web` therefore depends on the same pinned version.
 */
const sharpModule = await import(/* webpackIgnore: true */ "sharp").catch(() => null);
const sharp = sharpModule === null ? undefined : (sharpModule.default ?? sharpModule);
const databaseUri = process.env["PAYLOAD_DATABASE_URI"] ?? "";
const tls =
  databaseUri === "" ? { connectionString: "" } : tlsOptionsForDatabaseUrl(databaseUri);

/**
 * Storage is conditional by design: with S3 credentials present, uploads go
 * to that bucket (staging/Vercel); without them, the s3Storage plugin is
 * omitted and Payload's built-in local-disk storage takes over, writing to
 * the media collection's `staticDir` (gitignored, served through the CMS
 * file route). A fresh clone needs nothing beyond the database URL.
 */
const s3Configured = Boolean(
  process.env["S3_BUCKET"] &&
    process.env["S3_ACCESS_KEY_ID"] &&
    process.env["S3_SECRET_ACCESS_KEY"],
);

export default buildConfig({
  secret: process.env["PAYLOAD_SECRET"] ?? "",
  serverURL: process.env["NEXT_PUBLIC_APP_URL"] ?? "http://localhost:3000",
  csrf: [process.env["NEXT_PUBLIC_APP_URL"] ?? "http://localhost:3000"],
  routes: {
    admin: "/cms-admin",
    api: "/cms-api",
  },
  admin: {
    user: Operators.slug,
    importMap: {
      baseDir: srcDir,
      // The map is GENERATED, and this is where the generator writes it.
      //
      // Payload's CLI looks for the import map at `<rootDir>/src/app/(payload)<adminRoute>/`
      // and, because the admin route here is `/cms-admin`, that path does not
      // exist — the admin lives at `src/app/(payload)/[[...segments]]`. The
      // explicit `importMapFile` is the supported way to say where it is, and
      // it is also where the admin layout reads it from
      // (`apps/web/src/app/(payload)/layout.tsx`).
      //
      // This matters because the map is not optional decoration: it maps
      // `@payloadcms/next/rsc#CollectionCards` — the component that draws a
      // collection's card in the admin dashboard — to its implementation. An
      // empty map leaves the key unresolved, the admin logs "PayloadComponent
      // not found in importMap" for every card, and each collection renders as
      // a large empty icon. Measured: that is exactly what the admin looked
      // like before this file was generated.
      importMapFile,
    },
    meta: {
      titleSuffix: "— Raptor CMS",
      description: "Content administration for Raptor OS tenants.",
    },
  },
  editor: lexicalEditor(),
  sharp,
  db: postgresAdapter({
    pool: {
      connectionString: tls.connectionString,
      // One warm connection for the same cold-start reason as the app pools.
      min: 1,
      ...(tls.ssl === undefined ? {} : { ssl: tls.ssl }),
    },
    push: false,
    migrationDir: path.resolve(srcDir, "migrations"),
  }),
  collections: [Operators, Media, News, Pages, Partners],
  globals: [SiteSettings, Recruitment],
  plugins: s3Configured
    ? [
        s3Storage({
          collections: {
            cms_media: true,
          },
          bucket: process.env["S3_BUCKET"] ?? "",
          config: {
            credentials: {
              accessKeyId: process.env["S3_ACCESS_KEY_ID"] ?? "",
              secretAccessKey: process.env["S3_SECRET_ACCESS_KEY"] ?? "",
            },
            region: process.env["S3_REGION"] ?? "",
            endpoint: process.env["S3_ENDPOINT"] ?? "",
            forcePathStyle: true,
          },
        }),
      ]
    : [],
  typescript: {
    outputFile: path.resolve(srcDir, "payload-types.ts"),
  },
});
