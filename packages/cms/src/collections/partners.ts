import type { CollectionConfig } from "payload";

import { isOperator, publishedOrOperator } from "../access.js";

/**
 * Sponsors and partners. A partner row is NOT proof of sponsorship — the
 * public strip renders only published rows, and flipping one to published
 * requires the written approval recorded in `agreementRef`.
 */
export const Partners: CollectionConfig = {
  slug: "cms_partners",
  labels: {
    singular: "Partner",
    plural: "Partners",
  },
  dbName: "cms_partners",
  versions: {
    drafts: true,
  },
  admin: {
    useAsTitle: "name",
    defaultColumns: ["name", "tier", "_status"],
    group: "Content",
  },
  access: {
    read: publishedOrOperator,
    create: isOperator,
    update: isOperator,
    delete: isOperator,
  },
  fields: [
    { name: "name", type: "text", required: true },
    { name: "logo", type: "upload", relationTo: "cms_media", required: true },
    { name: "url", type: "text" },
    {
      name: "tier",
      type: "select",
      defaultValue: "community",
      options: [
        { label: "Title", value: "title" },
        { label: "Gold", value: "gold" },
        { label: "Silver", value: "silver" },
        { label: "Community", value: "community" },
      ],
    },
    {
      name: "agreementRef",
      type: "text",
      admin: { description: "Where the written approval lives. Empty means do not publish." },
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
