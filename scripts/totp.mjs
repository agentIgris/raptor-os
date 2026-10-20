#!/usr/bin/env node
/**
 * scripts/totp.mjs — RFC 6238 TOTP, computed locally.
 *
 * WHY THIS EXISTS
 * ---------------
 * Better Auth's `twoFactor` plugin hands the client an `otpauth://` URI and
 * then demands a 6-digit code that proves the client holds the secret inside
 * it. A human proves that with an authenticator app. A seed script has to
 * prove it with arithmetic, or the account can never leave the "pending" role
 * it was created in — `user_mfa_guard_trigger` (packages/auth/src/schema.sql)
 * refuses a manager/admin/owner whose `twoFactorEnabled` is not true, and
 * setting that column by hand does NOT create the `auth_two_factor` row the
 * plugin's own verification path needs.
 *
 * So the proof is made the way a phone makes it: same secret, same counter,
 * same truncation.
 *
 *   RFC 4226 (HOTP):  HMAC-SHA1 over an 8-byte big-endian counter.
 *   RFC 6238 (TOTP):  the counter is floor(unix_seconds / period).
 *   Truncation:      dynamic — the low nibble of the last digest byte picks
 *                     the 4-byte window, whose top bit is masked off.
 *
 * NO CONSUMER IN THIS BUILD, AND WHY IT IS STILL HERE
 * ----------------------------------------------------
 * The `twoFactor` plugin is not installed in this build (see "THE DEMO BUILD"
 * in packages/auth/src/config.ts): no challenge is issued, so the seed scripts
 * do not enrol anything and nothing in the repository calls this file. It
 * stays because it is the reference implementation of the proof the challenge
 * asks for, it has no dependencies, and re-enabling the challenge is a
 * one-entry change in `config.ts` — after which the enrolment step in
 * `scripts/create-role-accounts.mjs` needs exactly this arithmetic.
 *
 * DEPENDENCIES
 * ------------
 * `node:crypto` only. No package to add, no lockfile to churn, and the
 * implementation is small enough to read in one sitting — which matters for
 * anything that computes a credential.
 */

import { createHmac } from "node:crypto";

/** RFC 4648 base32, the encoding every authenticator app uses. */
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/**
 * Decode a base32 string into the raw bytes of the shared secret.
 *
 * Padding is optional (authenticator URIs rarely include it) and whitespace
 * is ignored, because both appear in the wild and neither changes the secret.
 *
 * @param {string} encoded
 * @returns {Buffer}
 */
export function base32Decode(encoded) {
  const cleaned = String(encoded).replace(/[\s=]+/g, "").toUpperCase();
  const bytes = [];
  let buffer = 0;
  let bits = 0;

  for (const character of cleaned) {
    const index = BASE32_ALPHABET.indexOf(character);
    if (index === -1) {
      throw new Error(`not a base32 character: ${JSON.stringify(character)}`);
    }
    buffer = (buffer << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >>> bits) & 0xff);
    }
  }

  return Buffer.from(bytes);
}

/**
 * RFC 4226 HOTP: one 6-digit code for one counter value.
 *
 * @param {Buffer} secret Raw shared secret.
 * @param {number} counter
 * @param {number} [digits]
 * @returns {string} Zero-padded to `digits` characters.
 */
export function hotp(secret, counter, digits = 6) {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));

  const digest = createHmac("sha1", secret).update(message).digest();
  const offset = digest[digest.length - 1] & 0x0f;

  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);

  return String(binary % 10 ** digits).padStart(digits, "0");
}

/**
 * RFC 6238 TOTP: the HOTP code for the counter that covers `timestamp`.
 *
 * @param {string} secretBase32 The shared secret, base32.
 * @param {{timestamp?: number, period?: number, digits?: number}} [options]
 *   `timestamp` is milliseconds (default: now). `period` is seconds (default 30).
 * @returns {string}
 */
export function generateTotp(secretBase32, options = {}) {
  const { timestamp = Date.now(), period = 30, digits = 6 } = options;
  const counter = Math.floor(timestamp / 1000 / period);
  return hotp(base32Decode(secretBase32), counter, digits);
}

/**
 * Read the secret (and the parameters) out of an `otpauth://` URI.
 *
 * The URI is what Better Auth returns from `POST /api/auth/two-factor/enable`,
 * and the secret is the one thing in it that must never be logged.
 *
 * @param {string} uri
 * @returns {{secret: string, period: number, digits: number, issuer: string, label: string}}
 */
export function parseTotpUri(uri) {
  const url = new URL(uri);
  if (url.protocol !== "otpauth:") {
    throw new Error(`not an otpauth:// URI: ${url.protocol}`);
  }

  const secret = url.searchParams.get("secret");
  if (secret === null || secret === "") {
    throw new Error("otpauth URI carries no secret");
  }

  return {
    secret,
    period: Number(url.searchParams.get("period") ?? "30"),
    digits: Number(url.searchParams.get("digits") ?? "6"),
    issuer: url.searchParams.get("issuer") ?? "",
    label: decodeURIComponent(url.pathname.replace(/^\//, "")),
  };
}

// -----------------------------------------------------------------------------
// CLI: `node scripts/totp.mjs <base32secret> [unixSeconds]`
//
// The secret is a credential. It is an argument here because the alternative
// — an environment variable — is no less visible to anyone who can read the
// process list, and this is a local developer tool that prints a code for a
// code the caller already holds.
// -----------------------------------------------------------------------------

if (process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))) {
  const [, , secretArgument, timeArgument] = process.argv;
  if (secretArgument === undefined) {
    console.error("usage: node scripts/totp.mjs <base32secret> [unixSeconds]");
    process.exit(2);
  }
  const timestamp = timeArgument === undefined ? Date.now() : Number(timeArgument) * 1000;
  console.log(generateTotp(secretArgument, { timestamp }));
}
