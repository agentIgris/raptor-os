import type { GlobalConfig } from "payload";

import { isOperator } from "../access.js";

/**
 * Recruitment switchboard. The public Join/Tryouts CTA renders ONLY while
 * `open` is true; otherwise the site shows the neutral contact CTA. Same
 * single-org limitation as Site Settings (see its docblock).
 */
export const Recruitment: GlobalConfig = {
  slug: "cms_recruitment",
  label: "Recruitment",
  dbName: "cms_recruitment",
  access: {
    read: () => true,
    update: isOperator,
  },
  fields: [
    { name: "open", type: "checkbox", defaultValue: false },
    { name: "heading", type: "text" },
    { name: "body", type: "richText" },
    {
      name: "formTarget",
      type: "text",
      admin: { description: "Where applications go (form URL or inbox). Stated on the form itself." },
    },
  ],
};
