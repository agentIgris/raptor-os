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
 *
 * The component import map is GENERATED, not hand-maintained:
 * `pnpm --filter @raptor/cms cms:generate-importmap` writes it, and the
 * config points the generator at this exact file. An empty or stale map leaves
 * the admin's own components unresolved — the collection cards render as large
 * empty icons — so the generated file is committed and CI checks that it
 * matches what the generator produces.
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
