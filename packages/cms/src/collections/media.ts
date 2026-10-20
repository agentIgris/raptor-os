import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CollectionConfig } from "payload";

import { isOperator } from "../access.js";

const collectionsDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * Where uploaded files live when no S3 bucket is configured (the local-first
 * default). Resolved against this file, not the cwd, because the CMS boots
 * from whichever process mounts it (the web app in dev, `payload` in CLI) and
 * a relative path would silently follow that cwd. The directory is
 * gitignored; S3 mode ignores it entirely.
 */
const localStaticDir = path.resolve(
  collectionsDir,
  "..",
  "..",
  process.env["CMS_MEDIA_DIR"] ?? ".media",
);

/**
 * Media library. With an S3 bucket configured, files land in that bucket
 * (public) via the s3Storage plugin; without one, files land on local disk
 * in `localStaticDir` and are served by the CMS file route
 * (`/cms-api/cms_media/file/<filename>`). Payload rows carry the metadata,
 * crops and focal points either way.
 *
 * Read is open because the store is public and URLs are guessable — an
 * access rule pretending otherwise would be theatre. The control that
 * matters is that the PUBLIC SITE only ever embeds media attached to
 * published documents, which is a rendering rule, not this flag.
 */
export const Media: CollectionConfig = {
  slug: "cms_media",
  labels: {
    singular: "Media",
    plural: "Media",
  },
  dbName: "cms_media",
  upload: {
    staticDir: localStaticDir,
    imageSizes: [
      { name: "thumb", width: 256, height: 256 },
      { name: "card", width: 800, height: 600 },
      { name: "hero", width: 1920, height: 1080 },
    ],
    mimeTypes: ["image/*"],
    adminThumbnail: "card",
  },
  admin: {
    useAsTitle: "filename",
    defaultColumns: ["filename", "mimeType", "filesize"],
    group: "Content",
  },
  access: {
    read: () => true,
    create: isOperator,
    update: isOperator,
    delete: isOperator,
  },
  fields: [
    {
      name: "alt",
      type: "text",
      required: true,
      admin: {
        description: "Meaningful alternative for informative images; decorative images stay out of articles.",
      },
    },
    {
      name: "credit",
      type: "text",
      admin: {
        description: "Photographer / source / license. Required before flipping any row that uses this file to approved.",
      },
    },
  ],
};
