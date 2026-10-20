"use client";

import { createAuthClient } from "better-auth/react";
import { useRouter } from "next/navigation";
import * as React from "react";

import { Alert, Button, TextField } from "@raptor/ui";

import { bindDefaultOrg } from "../../../server/org-actions";

/**
 * Sign-in.
 *
 * SESSION HANDLING — THE PART THAT MUST NOT BE WRITTEN WRONG
 * ----------------------------------------------------------
 * `createAuthClient` communicates with `/api/auth/*` using the browser's
 * credentials. The session it receives is an `httpOnly` cookie, which means
 * **JavaScript in this file cannot read the session at all**, and there is
 * nothing here to cache into `localStorage` even if someone tried.
 *
 * The legacy application did the opposite: it stored the session *including
 * the refresh token* in `localStorage` (AUDIT/09, F-AUTH-01, HIGH), so any XSS
 * anywhere in the origin became persistent account takeover — for admins too,
 * because the token was a full session rather than a short-lived one. That is
 * the single worst defect in the audit, it is invisible in review, and it is
 * trivially reintroduced by someone who has seen a hundred other apps do it.
 *
 * So: this component stores nothing, reads nothing, and there is no code path
 * by which a token reaches client-side storage.
 * `src/__tests__/no-client-token-storage.test.ts` scans the whole source tree
 * for `localStorage` / `sessionStorage` and fails the build if it reappears.
 *
 * ONE STAGE, NOT TWO
 * ------------------
 * This form used to have a second stage: an enrolled account was answered
 * `twoFactorRedirect` and the form asked for a 6-digit code. The `twoFactor`
 * plugin is no longer installed on the server (see "THE DEMO BUILD" in
 * `packages/auth/src/config.ts`), so there is no challenge to answer and no
 * `/two-factor/*` route to answer it with. A password is the whole sign-in, for
 * an owner and for an ordinary player alike.
 *
 * The client is not asked to detect the difference: the server no longer sends
 * a challenge, so the branch that used to switch stages is gone rather than
 * left to fail. A build that re-enables the challenge server-side needs the
 * stage back — and the flag it reads, `twoFactorEnabled`, is still returned by
 * the server.
 *
 * ERROR HANDLING
 * --------------
 * Two codes are surfaced verbatim because the user has to act on them:
 * `MFA_REQUIRED` (an account that is privileged but carries no enrolment flag)
 * and `INVALID_CREDENTIALS` (retry). Everything else becomes one generic
 * sentence. Better Auth's raw error messages are not written for end users and
 * echoing them can disclose whether an account exists.
 */

/** Codes the UI is allowed to show. Anything else is collapsed. */
const SHOWN_ERROR_CODES: Readonly<Record<string, string>> = {
  MFA_REQUIRED:
    "This account needs multi-factor authentication. Enrol an authenticator app before signing in.",
  INVALID_CREDENTIALS: "That email and password combination was not recognised.",
  USER_NOT_FOUND: "That email and password combination was not recognised.",
};

/**
 * One Better Auth client for the whole flow.
 *
 * No client plugin: the two-factor client plugin was what put the
 * `twoFactor.verifyTotp` action on the client, and there is no challenge to
 * verify in this build.
 */
const authClient = createAuthClient();

/**
 * Read one named value out of a submitted form as a string.
 *
 * `FormData.get()` returns `FormDataEntryValue | null`, which includes `File`.
 * Coercing that with `String()` is how a file upload ends up submitted as the
 * literal text `[object File]` — a value that looks present, passes a truthiness
 * check, and is not what the user typed. Anything that is not a string is
 * treated as absent.
 */
function readFormValue(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}

function describeError(code: string | undefined): string {
  if (code === undefined) return "Sign-in failed. Try again, or contact an organisation owner.";
  return SHOWN_ERROR_CODES[code] ?? "Sign-in failed. Try again, or contact an organisation owner.";
}

export interface SignInFormProps {
  /** Where to go after a successful sign-in. Server-provided, never read from the URL. */
  readonly callbackUrl: string;
  /**
   * Whether the server has Google OAuth credentials. Server-computed from its
   * own environment and passed as a boolean — the client never sees the values.
   * When false, no Google button renders at all: a button that dies on Google's
   * error page strands the user outside the app.
   */
  readonly googleEnabled: boolean;
}

export function SignInForm({ callbackUrl, googleEnabled }: SignInFormProps): React.JSX.Element {
  const router = useRouter();
  const [pending, setPending] = React.useState(false);
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);
  const [showPassword, setShowPassword] = React.useState(false);
  const errorRef = React.useRef<HTMLDivElement>(null);

  // The part both the password path and the code path end on. Binding the one
  // organisation the account belongs to (if there is exactly one) removes the
  // manual "paste an org id" step for everyone else; it is best-effort, and the
  // switcher remains the fallback when there is zero or more than one.
  const finishSignIn = React.useCallback(async (): Promise<void> => {
    try {
      await bindDefaultOrg();
    } catch {
      // Best-effort: the manual switcher is the standing fallback.
    }
    // `router.refresh()` re-runs the server components, so the layout's
    // session guard sees the cookie that was just set. Without it the user
    // would be bounced straight back to this page.
    router.replace(callbackUrl);
    router.refresh();
  }, [callbackUrl, router]);

  const onGoogleSignIn = async (): Promise<void> => {
    if (pending) return;
    setPending(true);
    setErrorMessage(null);
    try {
      // A full navigation, not fetch: the OAuth dance leaves the origin for
      // Google and returns to the callback URL. The session still arrives as an
      // httpOnly cookie — nothing here reads a token, same as the email flow.
      await authClient.signIn.social({ provider: "google", callbackURL: callbackUrl });
    } catch {
      setErrorMessage("Sign-in failed. Try again, or contact an organisation owner.");
    } finally {
      setPending(false);
    }
  };
  const onSubmit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (pending) return;

    setPending(true);
    setErrorMessage(null);

    const form = new FormData(event.currentTarget);
    const email = readFormValue(form, "email");
    const password = readFormValue(form, "password");

    try {
      const result = await authClient.signIn.email({ email, password, callbackURL: callbackUrl });

      if (result.error !== null && result.error !== undefined) {
        // `status` is `string | number` in Better Auth's error type; it is a
        // fallback code, so it is stringified rather than branched on. The
        // branch is on `code`, which is stable.
        setErrorMessage(describeError(result.error.code ?? String(result.error.status)));
        return;
      }

      await finishSignIn();
    } catch {
      setErrorMessage("Sign-in failed. Try again, or contact an organisation owner.");
    } finally {
      setPending(false);
    }
  };

  // Move focus to the error when it appears, so keyboard and screen-reader
  // users land on the message instead of having to hunt for what changed.
  React.useEffect(() => {
    if (errorMessage !== null) errorRef.current?.focus();
  }, [errorMessage]);

  return (
    <form
      onSubmit={(event) => {
        void onSubmit(event);
      }}
      className="flex min-w-0 flex-col gap-6"
      noValidate={false}
    >
      {errorMessage === null ? null : (
        <div ref={errorRef} tabIndex={-1}>
          <Alert tone="danger" politeness="assertive">
            <p className="text-[length:var(--text-sm)] leading-[var(--leading-normal)] font-medium">{errorMessage}</p>
          </Alert>
        </div>
      )}

      <TextField
        id="sign-in-email"
        name="email"
        type="email"
        label="Email address"
        autoComplete="email"
        inputMode="email"
        spellCheck={false}
        placeholder="you@organisation.gg…"
        required
      />

      <div className="flex min-w-0 flex-col gap-2">
        <TextField
          id="sign-in-password"
          name="password"
          type={showPassword ? "text" : "password"}
          label="Password"
          autoComplete="current-password"
          spellCheck={false}
          placeholder="Your 12+ character password…"
          hint="At least 12 characters."
          required
        />
        <div>
          <button
            type="button"
            aria-pressed={showPassword}
            aria-controls="sign-in-password"
            onClick={() => {
              setShowPassword((was) => !was);
            }}
            className="inline-flex min-h-11 cursor-pointer touch-manipulation items-center rounded-md px-3 py-2 text-[length:var(--text-sm)] font-medium text-ink-muted underline underline-offset-4 transition-colors duration-[var(--duration-fast)] ease-[var(--ease-standard)] hover:bg-sunken hover:text-ink"
          >
            {showPassword ? "Hide password" : "Show password"}
          </button>
        </div>
      </div>

      <Button type="submit" size="lg" disabled={pending} aria-busy={pending} className="w-full">
        {pending ? "Signing in…" : "Sign in"}
      </Button>

      {googleEnabled ? (
        <>
          <div className="flex min-w-0 items-center gap-3" aria-hidden="true">
            <span className="h-px flex-1 bg-border" />
            <span className="text-[length:var(--text-sm)] break-words text-ink-muted">or</span>
            <span className="h-px flex-1 bg-border" />
          </div>
          <Button
            type="button"
            size="lg"
            variant="outline"
            disabled={pending}
            aria-busy={pending}
            className="w-full"
            onClick={() => {
              void onGoogleSignIn();
            }}
          >
            {pending ? "Signing in…" : "Continue with Google"}
          </Button>
        </>
      ) : null}

      {/*
        Status region.

        The button's own label changes to "Signing in…", which is visible but NOT
        announced reliably — a label change on a control a screen reader is not
        focused on is often missed entirely. This live region announces the
        state change explicitly, and it is `role="status"` so it does not
        interrupt.
      */}
      <p role="status" aria-live="polite" className="min-h-6 text-[length:var(--text-sm)] break-words text-ink-muted">
        {pending ? "Signing in. This can take a few seconds." : ""}
      </p>
    </form>
  );
}