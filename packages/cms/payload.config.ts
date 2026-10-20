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
