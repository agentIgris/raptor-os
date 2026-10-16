import config from "@payload-config";
import type { ServerFunctionClient } from "payload";
import { handleServerFunctions, RootLayout } from "@payloadcms/next/layouts";
import React from "react";

import { importMap } from "./importMap.js";

type Args = {
  children: React.ReactNode;
};

/**
 * Layout for the Payload CMS routes (`/cms-admin`, `/cms-api`).
 *
 * Scoped to the `(payload)` route group: it never wraps `(site)` or `(app)`,
 * so the CMS admin CSS/JS cannot leak into the public or workspace bundles.
 * The component import map is hand-maintained while the admin has no custom
 * components; switch to `payload generate:importmap` the day one is added.
 */
const serverFunction: ServerFunctionClient = async function (args) {
  "use server";
  return handleServerFunctions({
    ...args,
    config,
    importMap,
  });
};

const PayloadLayout = ({ children }: Args): React.JSX.Element => (
  <RootLayout config={config} importMap={importMap} serverFunction={serverFunction}>
    {children}
  </RootLayout>
);

export default PayloadLayout;
