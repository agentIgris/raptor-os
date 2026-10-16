import type { CollectionConfig } from "payload";

import { isOperator, publishedOrOperator } from "../access.js";

/**
 * Long-lived pages (about, tryouts info, partner inquiries).
 *
 * Blocks reference domain data by SLUG STRINGS, never foreign keys: the CMS
 * must not join into the 91 domain tables, and the site resolves each
 * reference through the tenant-scoped queries it already uses. A dangling
 * slug renders the block's empty state, never a crash.
 */
export const Pages: CollectionConfig = {
  slug: "cms_pages",
  labels: {
    singular: "Page",
    plural: "Pages",
  },
  dbName: "cms_pages",
  versions: {
    drafts: true,
  },
  admin: {
    useAsTitle: "title",
    defaultColumns: ["title", "slug", "_status"],
    group: "Content",
  },
  access: {
    read: publishedOrOperator,
    create: isOperator,
    update: isOperator,
    delete: isOperator,
  },
  fields: [
    { name: "title", type: "text", required: true },
    {
      name: "slug",
      type: "text",
      required: true,
      unique: true,
      index: true,
      admin: { description: "URL path, e.g. about. Never changes after publish." },
    },
    {
      name: "sections",
      type: "blocks",
      blocks: [
        {
          slug: "hero",
          fields: [
            { name: "eyebrow", type: "text" },
            { name: "heading", type: "text", required: true },
            { name: "supporting", type: "textarea" },
            { name: "primaryLabel", type: "text" },
            { name: "primaryHref", type: "text" },
            { name: "secondaryLabel", type: "text" },
            { name: "secondaryHref", type: "text" },
            { name: "image", type: "upload", relationTo: "cms_media" },
          ],
        },
        {
          slug: "richText",
          fields: [{ name: "body", type: "richText", required: true }],
        },
        {
          slug: "media",
          fields: [
            { name: "image", type: "upload", relationTo: "cms_media", required: true },
            { name: "caption", type: "text" },
          ],
        },
        {
          slug: "divisionSpotlight",
          fields: [
            {
              name: "divisionSlug",
              type: "text",
              required: true,
              admin: { description: "Division slug in the domain database (e.g. bgmi). Resolved at render; dangling slugs show an empty state." },
            },
          ],
        },
      ],
    },
    {
      name: "orgId",
      type: "text",
      required: true,
      index: true,
      admin: { description: "Owning organization id. Validated against membership in Task 9." },
    },
  ],
};
