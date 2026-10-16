import path from "node:path";
import { fileURLToPath } from "node:url";
import { postgresAdapter } from "@payloadcms/db-postgres";
import { lexicalEditor } from "@payloadcms/richtext-lexical";
import { s3Storage } from "@payloadcms/storage-s3";
import { tlsOptionsForDatabaseUrl } from "@raptor/auth/config";
import { buildConfig } from "payload";
import sharp from "sharp";

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
 * Empty-string guard: `tlsOptionsForDatabaseUrl` parses with `new URL`,
 * which throws on `""`. The build evaluates this file without environment
 * (repo `.env.local` lives at the monorepo root, which Next does not read),
 * so an unset `PAYLOAD_DATABASE_URI` must degrade to an empty connection
 * string here and fail loudly at first request — not at build collection.
 */
const databaseUri = process.env["PAYLOAD_DATABASE_URI"] ?? "";
const tls =
  databaseUri === "" ? { connectionString: "" } : tlsOptionsForDatabaseUrl(databaseUri);

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
  plugins: [
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
  ],
  typescript: {
    outputFile: path.resolve(srcDir, "payload-types.ts"),
  },
});
