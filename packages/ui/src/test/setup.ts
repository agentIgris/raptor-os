/**
 * Test setup.
 *
 * Deliberately tiny. Every line here is a line that would otherwise be copied
 * into each accessibility test, and every one of them exists to make a failure
 * mean what it says.
 */

import "@testing-library/jest-dom/vitest";

import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => {
  cleanup();
});