#!/usr/bin/env node
/**
 * scripts/create-role-accounts.mjs — seed one loginable account per role.
 *
 * WHAT THIS PRODUCES
 * ------------------
 * Seven accounts — pending, player, coach, analyst, manager, admin, owner —
 * that can actually sign in to the local dev stack, hold a session with an
 * active organisation, and be authorised as their role. The seed covers BOTH
 * halves of the identity model, because neither half works alone:
 *
 *   packages/auth (Better Auth)  →  auth_user, auth_account, auth_session
 *   packages/db  (domain)        →  person, identity, person_profile,
 *                                    org_membership, role, role_assignment,
 *                                    person_credential_link
 *
 * `person_credential_link` is the join between them (ADR-0018). Without it
 * `auth_set_active_org` fails closed — a login with no person cannot satisfy
 * the membership test, so the session can never carry an active organisation.
 *
 * THE ORDER IS NOT ARBITRARY
 * --------------------------
 * Every step is blocked by the previous one:
 *
 *   1. SIGN UP over HTTP, without a `role` in the body. The `role` column is
 *      declared `input: false` in packages/auth/src/config.ts, so Better Auth
 *      answers FIELD_NOT_ALLOWED for a body that carries it, and the account
 *      lands on the default role `pending` — the safe default, and the only
 *      one available before the role is granted.
 *   2. MARK THE EMAIL VERIFIED in the database. `requireEmailVerification` is
 *      true, so sign-in refuses an unverified address.
 *   3. SIGN IN over HTTP and keep the session cookie.
 *   4. GRANT THE ROLE, in one statement that sets `twoFactorEnabled` too.
 *      `user_mfa_guard_trigger` refuses a privileged row whose
 *      `twoFactorEnabled` is not true, and refuses an attempt to switch MFA
 *      off for a privileged role. One statement satisfies both.
 *   5. WRITE THE DOMAIN ROWS, then call `auth_set_active_org` — the only
 *      function permitted to write `auth_session."orgId"`.
 *
 * WHY THERE IS NO TOTP ENROLMENT ANY MORE
 * ---------------------------------------
 * This seed used to enable TOTP over HTTP and then prove the secret with
 * scripts/totp.mjs, because the `twoFactor` plugin challenged every enrolled
 * account at sign-in and the demo had to answer that challenge to reach a
 * session. The plugin is no longer installed (see "THE DEMO BUILD" in
 * packages/auth/src/config.ts): the sign-in is a password and nothing else, and
 * no challenge is ever issued.
 *
 * The `twoFactorEnabled` flag is still written, and it is still REQUIRED for a
 * privileged role — the policy in roles.ts, the two gates in config.ts and the
 * `user_mfa_guard_trigger` in the database all refuse a privileged account
 * without it. The flag is therefore a PROVISIONING state, not a runtime
 * challenge: the account is created as an enrolled one, and the demo never
 * asks anyone for a 6-digit code.
 *
 * RE-RUNNING
 * ----------
 * The script owns its seven accounts. Re-running it deletes their auth rows
 * and rebuilds them, so a failed run can be repeated without hand-editing the
 * database. The domain rows are reused, not duplicated.
 *
 * SECRETS
 * -------
 * The password is written to `.data/seed-role-accounts.json`, which
 * `.gitignore` excludes. Nothing secret is printed to the console.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  CookieJar,
  REPO_ROOT,
  adminClient,
  appClient,
  applyEnvFile,
  authCall,
  baseUrl,
} from "./lib/local-dev-auth.mjs";

/** The local superuser's password, and the app password, from the local bootstrap. */
const LOCAL_PASSWORD = "raptor_local_dev_only";

/** The organisation every seeded account belongs to. */
const ORG_ID = "0c295a27-1295-4dcf-9a0e-2f77a772f14d";
const ORG_SLUG = "raptor";

const OUTPUT_FILE = path.join(REPO_ROOT, ".data", "seed-role-accounts.json");

/**
 * The seven accounts. `role` mirrors the CHECK constraint on `auth_user.role`
 * and the `key` column of the domain `role` table.
 */
const ACCOUNTS = [
  { role: "owner", name: "Raptor Owner", email: "owner@raptor.local" },
  { role: "admin", name: "Raptor Admin", email: "admin@raptor.local" },
  { role: "manager", name: "Raptor Manager", email: "manager@raptor.local" },
  { role: "analyst", name: "Raptor Analyst", email: "analyst@raptor.local" },
  { role: "coach", name: "Raptor Coach", email: "coach@raptor.local" },
  { role: "player", name: "Raptor Player", email: "player@raptor.local" },
  { role: "pending", name: "Raptor Pending", email: "pending@raptor.local" },
];

const step = (message) => console.log(`==> ${message}`);
const detail = (message) => console.log(`    ${message}`);

function fail(message) {
  console.error(`\ncreate-role-accounts: ${message}`);
  process.exit(1);
}

// -----------------------------------------------------------------------------
// The seed
// -----------------------------------------------------------------------------

/**
 * Remove a previous version of this account's authentication rows.
 *
 * The domain rows are left alone: they are reused by the upserts below, and
 * `person` rows are cheap to keep and expensive to churn.
 */
async function resetAccountAuth(admin, email) {
  await admin.query(
    `DELETE FROM person_credential_link
      WHERE "user_id" IN (SELECT "id" FROM auth_user WHERE "email" = $1)`,
    [email],
  );
  await admin.query(`DELETE FROM auth_user WHERE "email" = $1`, [email]);
}

/** Mark the address as proven, which `requireEmailVerification` demands. */
async function verifyEmail(admin, email) {
  await admin.query(`UPDATE auth_user SET "emailVerified" = true WHERE "email" = $1`, [email]);
}

/**
 * Grant the role.
 *
 * One statement, setting `twoFactorEnabled` alongside the role, because
 * `user_mfa_guard_trigger` inspects the NEW row: a privileged role is accepted
 * only when the new row is already MFA-enabled, and an update that switched
 * MFA off for a privileged role is refused outright.
 */
async function grantRole(admin, email, role) {
  await admin.query(
    `UPDATE auth_user SET "role" = $2, "twoFactorEnabled" = true WHERE "email" = $1`,
    [email, role],
  );
}

/** Create (or reuse) the role row for this organisation. */
async function ensureRole(admin, role) {
  await admin.query(
    `INSERT INTO role (org_id, key, name, is_system)
     VALUES ($1, $2, $3, true)
     ON CONFLICT (org_id, key) DO NOTHING`,
    [ORG_ID, role, role],
  );
  const result = await admin.query(`SELECT id FROM role WHERE org_id = $1 AND key = $2`, [ORG_ID, role]);
  const row = result.rows[0];
  if (row === undefined) throw new Error(`role "${role}" could not be read back`);
  return row.id;
}

/** Create (or reuse) the person, its profile and its email identity. */
async function ensurePerson(admin, account) {
  const externalRef = `seed:role:${account.role}`;

  const existing = await admin.query(`SELECT id FROM person WHERE external_ref = $1`, [externalRef]);
  const existingRow = existing.rows[0];

  let personId;
  if (existingRow !== undefined) {
    personId = existingRow.id;
  } else {
    const inserted = await admin.query(`INSERT INTO person (external_ref) VALUES ($1) RETURNING id`, [
      externalRef,
    ]);
    personId = inserted.rows[0].id;
  }

  await admin.query(
    `INSERT INTO person_profile (person_id, display_name, profile_visibility)
     VALUES ($1, $2, 'org')
     ON CONFLICT (person_id) DO UPDATE SET display_name = EXCLUDED.display_name`,
    [personId, account.name],
  );

  await admin.query(
    `INSERT INTO identity (person_id, method, identifier, verified_at)
     VALUES ($1, 'email', $2, now())
     ON CONFLICT (method, identifier) DO NOTHING`,
    [personId, account.email],
  );

  return personId;
}

/** Bind the login to the person, and make the person a member of the org. */
async function ensureMembership(admin, personId, userId) {
  await admin.query(
    `INSERT INTO person_credential_link (person_id, user_id)
     VALUES ($1, $2)
     ON CONFLICT DO NOTHING`,
    [personId, userId],
  );

  await admin.query(
    `INSERT INTO org_membership (org_id, person_id, status, joined_at)
     VALUES ($1, $2, 'active', now())
     ON CONFLICT (org_id, person_id) DO UPDATE
       SET status = 'active', joined_at = COALESCE(org_membership.joined_at, now())`,
    [ORG_ID, personId],
  );
}

/** Grant the role to the person for as long as the assignment stands. */
async function ensureRoleAssignment(admin, personId, roleId) {
  await admin.query(
    `INSERT INTO role_assignment (org_id, person_id, role_id, scope_type, valid_from)
     VALUES ($1, $2, $3, 'organization', now())
     ON CONFLICT DO NOTHING`,
    [ORG_ID, personId, roleId],
  );
}

/**
 * Point the session at the organisation.
 *
 * `auth_set_active_org` is the only writer of `auth_session."orgId"`, it is
 * SECURITY DEFINER, and it refuses anything whose person has no ACTIVE
 * membership — so the membership must be in place first. It is called through
 * the application role because that is the role the grant belongs to.
 */
async function setActiveOrg(app, sessionToken) {
  const result = await app.query(`SELECT auth_set_active_org($1, $2) AS ok`, [sessionToken, ORG_ID]);
  return result.rows[0]?.ok === true;
}

// -----------------------------------------------------------------------------

async function main() {
  applyEnvFile();
  const origin = baseUrl();

  console.log("Raptor OS — role account seed");
  console.log(`app:    ${origin}`);
  console.log(`org:    ${ORG_ID} (${ORG_SLUG})`);

  const admin = adminClient();
  const app = appClient();
  try {
    await admin.connect();
    await app.connect();
  } catch (error) {
    fail(`could not connect to Postgres: ${error.message}`);
  }

  const credentials = [];

  try {
    const organization = await admin.query(`SELECT id, slug, status FROM organization WHERE id = $1`, [ORG_ID]);
    if (organization.rowCount === 0) {
      fail(`organisation ${ORG_ID} does not exist — run scripts/setup-local.mjs first`);
    }
    detail(`organisation ${organization.rows[0].slug} is ${organization.rows[0].status}`);

    for (const account of ACCOUNTS) {
      step(`${account.role} — ${account.email}`);

      // 1. Clear any previous version of this account.
      await resetAccountAuth(admin, account.email);

      // 2. Sign up. The body carries no `role`: the field is `input: false`.
      const signUp = await authCall(
        "/sign-up/email",
        {
          body: { name: account.name, email: account.email, password: LOCAL_PASSWORD },
          baseUrl: origin,
        },
      );
      if (signUp.status !== 200) {
        fail(`sign-up for ${account.email} failed with ${signUp.status}: ${signUp.text}`);
      }
      detail(`signed up`);

      // 3. The address is proven locally, so the verification gate is satisfied.
      await verifyEmail(admin, account.email);

      // 4. Sign in and keep the session cookie.
      const jar = new CookieJar();
      const signIn = await authCall(
        "/sign-in/email",
        { body: { email: account.email, password: LOCAL_PASSWORD }, jar, baseUrl: origin },
      );
      if (signIn.status !== 200) {
        fail(`sign-in for ${account.email} failed with ${signIn.status}: ${signIn.text}`);
      }
      if (jar.sessionToken() === undefined) {
        fail(`sign-in for ${account.email} returned no session cookie`);
      }
      detail(`signed in`);

      // 5. Grant the role now that MFA exists.
      await grantRole(admin, account.email, account.role);
      detail(`role granted: ${account.role}`);

      // 6. The domain side.
      const userRows = await admin.query(`SELECT id FROM auth_user WHERE "email" = $1`, [account.email]);
      const userId = userRows.rows[0]?.id;
      if (userId === undefined) throw new Error(`no auth_user row for ${account.email}`);

      const personId = await ensurePerson(admin, account);
      const roleId = await ensureRole(admin, account.role);
      await ensureMembership(admin, personId, userId);
      await ensureRoleAssignment(admin, personId, roleId);
      detail(`domain rows written`);

      // 7. Give the session an active organisation.
      const sessionToken = jar.sessionToken();
      if (sessionToken === undefined) throw new Error(`no session token for ${account.email}`);
      const active = await setActiveOrg(app, sessionToken);
      if (!active) {
        fail(`auth_set_active_org refused ${account.email} — check the membership row`);
      }
      detail(`session bound to the organisation`);

      credentials.push({
        role: account.role,
        email: account.email,
        password: LOCAL_PASSWORD,
        name: account.name,
        userId,
        personId,
      });
    }

    step("summary");
    const counts = await admin.query(
      `
      SELECT (SELECT count(*) FROM auth_user)                      AS auth_user,
             (SELECT count(*) FROM auth_two_factor)                AS auth_two_factor,
             (SELECT count(*) FROM identity)                       AS identity,
             (SELECT count(*) FROM person WHERE external_ref LIKE 'seed:%') AS seeded_person,
             (SELECT count(*) FROM org_membership WHERE status = 'active')  AS active_membership,
             (SELECT count(*) FROM role)                           AS role,
             (SELECT count(*) FROM role_assignment)                AS role_assignment,
             (SELECT count(*) FROM person_credential_link)         AS credential_link,
             (SELECT count(*) FROM auth_session WHERE "orgId" = $1) AS session_with_org
    `,
      [ORG_ID],
    );
    for (const [key, value] of Object.entries(counts.rows[0])) {
      detail(`${key}: ${value}`);
    }

    // The flag is the provisioning state the policy reads: a privileged account
    // without it is refused a session by the gates and by the database trigger.
    // The `auth_two_factor` table is empty in this build — no challenge is
    // issued, so no secret is ever created — and the count above says so.
    const privileged = await admin.query(`
      SELECT u."email", u."role", u."twoFactorEnabled"
        FROM auth_user u
       WHERE u."role" IN ('manager','admin','owner')
       ORDER BY u."role"
    `);
    for (const user of privileged.rows) {
      detail(`privileged: ${user.role} ${user.email} mfa=${user.twoFactorEnabled}`);
    }

    mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
    writeFileSync(
      OUTPUT_FILE,
      `${JSON.stringify({ organisation: ORG_ID, accounts: credentials }, null, 2)}\n`,
      "utf8",
    );
    detail(`credentials written to ${path.relative(REPO_ROOT, OUTPUT_FILE)} (gitignored)`);
  } finally {
    await admin.end().catch(() => undefined);
    await app.end().catch(() => undefined);
  }

  console.log("\nSeed complete.");
}

await main();
