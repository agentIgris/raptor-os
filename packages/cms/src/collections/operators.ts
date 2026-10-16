import type { CollectionConfig } from "payload";

import { betterAuthStrategy } from "../auth/better-auth-strategy.js";
import { isOperator } from "../access.js";

/**
 * CMS operators: the only accounts that can open `/cms-admin`.
 *
 * Deliberately NOT product users. Product identity lives in Better Auth
 * (`auth_user`, session cookies); these rows exist so content administration
 * has named, auditable actors. Unifying the two is Task 9 (custom auth
 * strategy); until then this collection holds at most a couple of operators.
 *
 * Fail-closed defaults: every access rule refuses. The Payload
 * create-first-user bootstrap bypasses access internally, so the setup screen
 * still works with zero operators. Task 2 refines these rules with tests.
 */
export const Operators: CollectionConfig = {
  slug: "cms_operators",
  labels: {
    singular: "Operator",
    plural: "Operators",
  },
  dbName: "cms_operators",
  auth: {
    maxLoginAttempts: 5,
    lockTime: 15 * 60 * 1000,
    verify: false,
    // Cut over (Task 9, proven live): Better Auth sessions are the ONLY way
    // in. CMS passwords no longer authenticate anything — one identity.
    disableLocalStrategy: true,
    strategies: [betterAuthStrategy],
    cookies: {
      secure: process.env["NODE_ENV"] === "production",
      sameSite: "Lax",
    },
  },
  admin: {
    useAsTitle: "email",
    defaultColumns: ["email", "role"],
  },
  access: {
    // Authenticated operators may open the admin and read the directory;
    // creating, editing or deleting OPERATORS stays impossible through the
    // API (operator provisioning is a database-level act). The first-user
    // bootstrap bypasses access internally, so setup still works at zero.
    // NOTE: `read` must admit operators, not just `admin` — Payload
    // serializes the session user through collection read access, so
    // read:false yields authenticated ghosts (id with no fields).
    read: isOperator,
    create: () => false,
    update: () => false,
    delete: () => false,
    unlock: () => false,
    // `admin` takes boolean only (no `where` queries): same predicate as
    // `isOperator`, restated in the narrower type the field requires.
    admin: ({ req }) => req.user !== null && req.user !== undefined,
  },
  fields: [
    {
      name: "role",
      type: "select",
      required: true,
      defaultValue: "editor",
      options: [
        { label: "Owner", value: "owner" },
        { label: "Editor", value: "editor" },
      ],
      access: {
        read: () => false,
        update: () => false,
      },
    },
  ],
};
