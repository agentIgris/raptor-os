"use client";

/**
 * The assistant's question box and answer panel.
 *
 * A client component because the answer arrives after interaction. It holds no
 * server state: `fetch` goes to `/api/assistant`, which owns authorisation and
 * the offline/provider decision. The response union is imported as a type
 * only — the server module itself is never bundled into the client.
 */

import type { AssistantToolName, OfflineAnswer } from "@raptor/assistant";
import { Alert, Button, Card, CardContent, CardHeader, CardTitle, TextField } from "@raptor/ui";
import * as React from "react";

import type { AssistantAnswer } from "../../server/assistant";

/** `modelLabel` names the configured model, or null when offline-only. */
export interface AssistantPanelProps {
  readonly modelLabel: string | null;
}

const TOOL_LABELS: Record<AssistantToolName, string> = {
  listTeams: "Teams",
  listCompetitions: "Competitions",
  getInsights: "Insights",
  getRoster: "Rosters",
  listMembers: "Members",
  getOrgOverview: "Organisation",
};

const MAX_QUESTION_LENGTH = 2_000;

type OfflineSection = OfflineAnswer["sections"][number];

function formValue(form: FormData, field: string): string {
  const value = form.get(field);
  return typeof value === "string" ? value : "";
}

function sectionBody(section: OfflineSection): string {
  return typeof section.data === "string" ? section.data : JSON.stringify(section.data, null, 2);
}

export function AssistantPanel({ modelLabel }: AssistantPanelProps): React.JSX.Element {
  const [pending, setPending] = React.useState(false);
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);
  const [answer, setAnswer] = React.useState<AssistantAnswer | null>(null);
  const errorRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    if (errorMessage !== null) errorRef.current?.focus();
  }, [errorMessage]);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (pending) return;
    const question = formValue(new FormData(event.currentTarget), "question").trim();
    if (question === "" || question.length > MAX_QUESTION_LENGTH) {
      setErrorMessage(`Ask one question of 1 to ${MAX_QUESTION_LENGTH} characters.`);
      return;
    }
    setPending(true);
    setErrorMessage(null);
    try {
      const response = await fetch("/api/assistant", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question }),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const message =
          typeof payload === "object" && payload !== null && "error" in payload
            ? (payload as { error?: unknown })["error"]
            : undefined;
        setErrorMessage(
          typeof message === "string" && message !== ""
            ? message
            : "The assistant could not answer. Try again shortly.",
        );
        return;
      }
      setAnswer(payload as AssistantAnswer);
    } catch {
      setErrorMessage("The assistant could not be reached. Try again shortly.");
    } finally {
      setPending(false);
    }
  }

  function renderSection(section: OfflineSection): React.JSX.Element {
    if (section.status === "skipped") {
      return <p className="text-[length:var(--text-sm)] text-ink-muted">{`${TOOL_LABELS[section.tool]}: not run for your role.`}</p>;
    }
    if (section.status === "error") {
      return (
        <Alert tone="danger">
          <p className="text-[length:var(--text-sm)] leading-[var(--leading-normal)] font-medium">
            {`${TOOL_LABELS[section.tool]}: ${section.error}`}
          </p>
        </Alert>
      );
    }
    return (
      <Card>
        <CardHeader>
          <CardTitle>{TOOL_LABELS[section.tool]}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="whitespace-pre-line text-[length:var(--text-sm)] leading-[var(--leading-normal)] break-words text-ink">
            {sectionBody(section)}
          </p>
        </CardContent>
      </Card>
    );
  }

  function renderAnswer(current: AssistantAnswer): React.JSX.Element {
    if (current.mode === "provider") {
      return (
        <Card>
          <CardHeader>
            <CardTitle>Answer</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="whitespace-pre-line text-[length:var(--text-sm)] leading-[var(--leading-normal)] break-words text-ink">
              {current.answer}
            </p>
          </CardContent>
        </Card>
      );
    }
    return (
      <div className="flex flex-col gap-4">
        {current.sections.map((section) => (
          <React.Fragment key={section.tool}>{renderSection(section)}</React.Fragment>
        ))}
        <p className="text-[length:var(--text-xs)] leading-[var(--leading-normal)] text-ink-faint">
          {current.disclaimer}
        </p>
      </div>
    );
  }

  return (
    <form
      className="flex min-w-0 flex-col gap-6"
      noValidate
      onSubmit={(event) => {
        void onSubmit(event);
      }}
    >
      {errorMessage === null ? null : (
        <div ref={errorRef} tabIndex={-1}>
          <Alert tone="danger" politeness="assertive">
            <p className="text-[length:var(--text-sm)] leading-[var(--leading-normal)] font-medium">{errorMessage}</p>
          </Alert>
        </div>
      )}

      <TextField
        id="assistant-question"
        name="question"
        type="text"
        label="Your question"
        hint={
          modelLabel === null
            ? "No model is configured, so answers list the raw workspace data your role may see."
            : `Answered by ${modelLabel}.`
        }
        placeholder="Which teams do we have?"
        autoComplete="off"
        spellCheck={false}
        maxLength={MAX_QUESTION_LENGTH}
      />

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" size="lg" disabled={pending}>
          {pending ? "Asking…" : "Ask the assistant"}
        </Button>
        <p role="status" aria-live="polite" className="min-h-6 text-[length:var(--text-sm)] text-ink-muted">
          {pending ? "Collecting workspace data for your role…" : ""}
        </p>
      </div>

      {answer === null ? (
        <p className="max-w-prose text-[length:var(--text-sm)] leading-[var(--leading-normal)] break-words text-ink-muted">
          Try questions about teams, competitions, rosters, members or analytics. The assistant only ever shows
          workspace data your role already has.
        </p>
      ) : (
        renderAnswer(answer)
      )}
    </form>
  );
}
