/**
 * @vitest-environment jsdom
 */

import { render, screen } from "@testing-library/react";
import * as React from "react";
import { describe, expect, it } from "vitest";

import { EmptyState } from "./empty-state";

describe("EmptyState", () => {
  it("renders title, description and action", () => {
    render(
      <EmptyState
        title="No allocations yet"
        description="Allocations appear once the pool is computed."
        action={<a href="/dashboard">Open dashboard</a>}
      />,
    );
    expect(screen.getByText("No allocations yet")).toBeInTheDocument();
    expect(screen.getByText("Allocations appear once the pool is computed.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open dashboard" })).toBeInTheDocument();
  });
});
