import { describe, expect, it } from "vitest";

import { toArticle, toPartner } from "./cms-view";

/**
 * CMS boundary mappers: only the rendered fields cross, everything else stays
 * in the CMS. Missing optionals default rather than crash.
 */
describe("cms boundary mappers", () => {
  it("maps an article, defaulting absent optionals to null", () => {
    expect(toArticle({ title: "T", slug: "t" })).toEqual({
      title: "T",
      slug: "t",
      excerpt: null,
      publishedAt: null,
    });
  });

  it("maps a partner, defaulting the tier to community", () => {
    expect(toPartner({ name: "P" })).toEqual({ name: "P", url: null, tier: "community" });
  });
});
