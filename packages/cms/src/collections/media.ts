import type { CollectionConfig } from "payload";

import { isOperator } from "../access.js";

/**
 * Media library. Files live in the `cms-media` Supabase bucket (public);
 * Payload rows carry the metadata, crops and focal points.
 *
 * Read is open because the bucket is public and URLs are guessable — an
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
