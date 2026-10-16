import type { CollectionConfig } from "payload";

import { isOperator, publishedOrOperator } from "../access.js";

/**
 * News and announcements. Drafts are invisible to logged-out callers
 * (`versions.drafts` maintains `_status`; `publishedOrOperator` enforces it
 * in the database, not the UI). The public feed queries published-only and
 * must never pass `overrideAccess`.
 */
export const News: CollectionConfig = {
  slug: "cms_news",
  labels: {
    singular: "Article",
    plural: "News",
  },
  dbName: "cms_news",
  versions: {
    drafts: true,
  },
  admin: {
    useAsTitle: "title",
    defaultColumns: ["title", "slug", "publishedAt", "_status"],
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
      admin: { description: "URL path segment, e.g. bgmi-roster-locked. Never changes after publish." },
    },
    { name: "excerpt", type: "textarea" },
    { name: "body", type: "richText" },
    { name: "cover", type: "upload", relationTo: "cms_media" },
    { name: "publishedAt", type: "date", admin: { position: "sidebar" } },
    {
      name: "orgId",
      type: "text",
      required: true,
      index: true,
      admin: { description: "Owning organization id (e.g. the Raptor org id). Validated against membership in Task 9." },
    },
    {
      name: "seo",
      type: "group",
      fields: [
        { name: "title", type: "text" },
        { name: "description", type: "textarea" },
        { name: "image", type: "upload", relationTo: "cms_media" },
      ],
    },
  ],
};
