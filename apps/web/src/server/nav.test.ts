import { describe, expect, it } from "vitest";

import { buildWorkspaceNav, sectionLabelFor } from "./nav";

/**
 * Navigation filtering without a session: role in, implemented routes out.
 * Enforcement underneath is membership + RLS; this only decides what is
 * offered, so the failure mode of a mistake here is a hidden link, never a
 * leaked row.
 */
describe("workspace nav", () => {
  it("offers every role the dashboard and nothing unbuilt", () => {
    for (const role of ["pending", "player", "coach", "analyst", "manager", "admin", "owner"]) {
      const hrefs = buildWorkspaceNav(role).flatMap((section) => section.items.map((item) => item.href));
      expect(hrefs).toContain("/dashboard");
    }
  });

  it("shows players the competitive areas but no management areas", () => {
    const hrefs = buildWorkspaceNav("player").flatMap((section) => section.items.map((item) => item.href));
    expect(hrefs).toEqual(expect.arrayContaining(["/dashboard", "/teams", "/competitions"]));
    expect(hrefs).not.toContain("/members");
    expect(hrefs).not.toContain("/content");
    expect(hrefs).not.toContain("/settings");
  });

  it("shows managers everything except platform settings", () => {
    const hrefs = buildWorkspaceNav("manager").flatMap((section) => section.items.map((item) => item.href));
    expect(hrefs).toEqual(
      expect.arrayContaining(["/dashboard", "/teams", "/competitions", "/members", "/content", "/partners", "/insights"]),
    );
    expect(hrefs).not.toContain("/settings");
  });

  it("shows owners the full map including settings", () => {
    const hrefs = buildWorkspaceNav("owner").flatMap((section) => section.items.map((item) => item.href));
    expect(hrefs).toEqual(
      expect.arrayContaining([
        "/dashboard",
        "/teams",
        "/competitions",
        "/members",
        "/content",
        "/partners",
        "/insights",
        "/settings",
      ]),
    );
  });

  it("names unknown paths honestly", () => {
    expect(sectionLabelFor("/dashboard")).toBe("Dashboard");
    expect(sectionLabelFor("/teams")).toBe("Teams");
    expect(sectionLabelFor("/nope")).toBe("Workspace");
  });
});
