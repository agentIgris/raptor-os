import * as React from "react";

import { cn } from "../lib/cn";

export interface TextFieldProps extends Omit<React.ComponentProps<"input">, "id"> {
  /**
   * Id shared by the `<label for>`, the `<input id>` and every element the
   * input points at with `aria-describedby`.
   *
   * REQUIRED rather than generated. `useId()` would have been less typing, but
   * a generated id cannot be referenced by a server component that needs to
   * point a `<a href="#field">` or an error summary at the field, and a label
   * association that silently breaks when the tree is streamed is exactly the
   * defect this product is supposed to not have.
   */
  id: string;
  /** The visible label text. There is no aria-label-only mode, by design. */
  label: string;
  /** Supplementary text rendered under the label and announced with the field. */
  hint?: string;
  /** Validation message. Renders an alert and puts the field in an invalid state. */
  error?: string;
}

/**
 * A labelled text input with its description and error text wired up.
 *
 * The wiring is the whole point of this component, so it is written out
 * rather than left to the call site:
 *
 *  - `htmlFor` / `id` — so the label is announced with the field.
 *  - `aria-describedby` — points at whichever of hint/error exist. Both when
 *    both do. A form that renders the hint but forgets to wire it produces a
 *    field whose instructions only exist for people who can see them.
 *  - `aria-invalid` — present (and `true`) only when there is an error, rather
 *    than always `false`. A permanently-"invalid" field trains assistive tech
 *    users to ignore the state.
 *  - the error is `role="alert"`, so a message added after submit is announced
 *    without the user having to go looking for what changed.
 *  - the visible asterisk is `aria-hidden`; the required state is conveyed by
 *    the `required` attribute and by screen-reader-only text. Announcing
 *    "asterisk" instead of "required" is a small, common, avoidable failure.
 */
export const TextField = React.forwardRef<HTMLInputElement, TextFieldProps>(function TextField(
  { className, id, label, hint, error, required, ...props },
  ref,
) {
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;

  const describedBy =
    [hint === undefined ? undefined : hintId, error === undefined ? undefined : errorId]
      .filter((value): value is string => value !== undefined)
      .join(" ") || undefined;

  const controlId = cn(
    "min-h-11 w-full rounded-md border border-control bg-canvas px-3",
    "text-[length:var(--text-sm)] text-ink placeholder:text-ink-faint",
    "touch-manipulation",
    "disabled:cursor-not-allowed disabled:bg-sunken disabled:text-ink-muted",
    error === undefined ? undefined : "border-danger",
    className,
  );

  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id} className="text-[length:var(--text-sm)] font-medium text-ink">
        {label}
        {required === true ? (
          <>
            <span aria-hidden="true" className="ml-1 text-danger">
              *
            </span>
            <span className="sr-only"> (required)</span>
          </>
        ) : null}
      </label>

      {hint === undefined ? null : (
        <p id={hintId} className="text-[length:var(--text-xs)] leading-[var(--leading-normal)] text-ink-muted">
          {hint}
        </p>
      )}

      <input
        {...props}
        ref={ref}
        id={id}
        required={required}
        className={controlId}
        {...(describedBy === undefined ? {} : { "aria-describedby": describedBy })}
        {...(error === undefined ? {} : { "aria-invalid": true })}
      />

      {error === undefined ? null : (
        <p id={errorId} role="alert" className="text-[length:var(--text-xs)] leading-[var(--leading-normal)] font-medium text-danger">
          {error}
        </p>
      )}
    </div>
  );
});