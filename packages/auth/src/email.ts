import { Resend } from "resend";

/**
 * Outbound mail for authentication flows, via Resend.
 *
 * SECRET HYGIENE
 * --------------
 * The verification/reset URLs below are bearer credentials for the account:
 * whoever opens one verifies or resets without a password. They are passed
 * to Resend and to nothing else — never logged, never returned, never
 * interpolated into an error message. Failure messages name the KIND of
 * failure, never the address or the URL.
 *
 * STAGING NOTE
 * ------------
 * Without a verified Resend domain, `EMAIL_FROM` stays on Resend's onboarding
 * sender and delivery is limited to the Resend account's own address. That is
 * a sender-side restriction, not something this module can or should work
 * around: it fails loudly through the normal error path instead.
 */

export const DEFAULT_EMAIL_FROM = "onboarding@resend.dev";

/** What the mailer needs. Both come from the validated environment. */
export interface EmailTransport {
  /** Absent means "not configured": every send fails loudly, never silently. */
  readonly apiKey: string | undefined;
  readonly from: string;
}

export interface AuthEmailUser {
  readonly email: string;
}

export interface AuthEmail {
  readonly user: AuthEmailUser;
  readonly url: string;
}

function client(transport: EmailTransport): Resend {
  if (transport.apiKey === undefined || transport.apiKey.trim() === "") {
    throw new Error("Email is not configured: set RESEND_API_KEY to send authentication mail.");
  }
  return new Resend(transport.apiKey);
}

function verificationHtml(url: string): string {
  return (
    `<p>Confirm your Raptor OS email address by opening the link below. It expires in one hour.</p>` +
    `<p><a href="${url}">Verify email address</a></p>` +
    `<p>If the button does not work, paste this address into your browser:</p>` +
    `<p>${url}</p>`
  );
}

function resetHtml(url: string): string {
  return (
    `<p>Someone requested a password reset for this Raptor OS account. If that was you, open the link below. It expires in 30 minutes.</p>` +
    `<p><a href="${url}">Reset password</a></p>` +
    `<p>If the button does not work, paste this address into your browser. If you did not ask for this, do nothing — the password stays unchanged.</p>` +
    `<p>${url}</p>`
  );
}

/** Send the sign-up email-verification message. */
export async function sendVerificationEmail(transport: EmailTransport, data: AuthEmail): Promise<void> {
  const { error } = await client(transport).emails.send({
    from: transport.from,
    to: data.user.email,
    subject: "Verify your Raptor OS email",
    html: verificationHtml(data.url),
  });
  if (error !== null) {
    throw new Error(`Verification email was refused: ${error.message}`);
  }
}

/** Send the password-reset message. */
export async function sendPasswordResetEmail(transport: EmailTransport, data: AuthEmail): Promise<void> {
  const { error } = await client(transport).emails.send({
    from: transport.from,
    to: data.user.email,
    subject: "Reset your Raptor OS password",
    html: resetHtml(data.url),
  });
  if (error !== null) {
    throw new Error(`Password-reset email was refused: ${error.message}`);
  }
}
