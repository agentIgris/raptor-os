import type { GlobalConfig } from "payload";

import { isOperator } from "../access.js";

/**
 * Site-wide settings: identity, navigation, socials, default SEO.
 *
 * SINGLE-ORG LIMITATION, stated plainly: globals carry no tenant field, so
 * this document describes the initial organization only. A second org needing
 * CMS settings promotes this to a tenant-scoped collection — that migration
 * is out of scope until org #2 exists.
 */
export const SiteSettings: GlobalConfig = {
  slug: "cms_site_settings",
  label: "Site Settings",
  dbName: "cms_site_settings",
  access: {
    read: () => true,
    update: isOperator,
  },
  fields: [
    { name: "siteName", type: "text", required: true, defaultValue: "Raptor Esports" },
    { name: "tagline", type: "text" },
    { name: "logo", type: "upload", relationTo: "cms_media" },
    {
      name: "socials",
      type: "array",
      fields: [
        {
          name: "network",
          type: "select",
          required: true,
          options: ["x", "instagram", "youtube", "twitch", "discord"],
        },
        { name: "url", type: "text", required: true },
      ],
    },
    {
      name: "defaultSeo",
      type: "group",
      fields: [
        { name: "title", type: "text" },
        { name: "description", type: "textarea" },
        { name: "image", type: "upload", relationTo: "cms_media" },
      ],
    },
  ],
};
