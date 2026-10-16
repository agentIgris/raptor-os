import type { Metadata } from "next";
import * as React from "react";

import { Community, Recruitment } from "../../components/public/community";
import { About } from "../../components/public/about";
import { Divisions } from "../../components/public/divisions";
import { Hero } from "../../components/public/hero";
import { NewsFeed } from "../../components/public/news";
import { Partners } from "../../components/public/partners";
import { ProofStrip } from "../../components/public/proof-strip";
import { Results } from "../../components/public/results";
import { Roster } from "../../components/public/roster";
import { getPublishedNews, getPublishedPartners, getRecruitment, getSiteSocials } from "../../server/cms";
import { getPublicDivisions, getPublicResults, getPublicTeams } from "../../server/public";

export const metadata: Metadata = {
  title: {
    absolute: "Raptor Esports",
  },
  description:
    "Raptor Esports: competitive rosters, results, news and recruitment. Verified content only — no invented stats.",
};

/**
 * Rendered per request, not prerendered. (See the previous revision's note:
 * the nonce CSP in `src/proxy.ts` cannot be satisfied by prerendered HTML,
 * and a multi-tenant landing page differs per tenant anyway.)
 */
export const dynamic = "force-dynamic";

/**
 * The public home: fan site, not console.
 *
 * Every section below reads live sources and degrades to designed
 * empty states — with an empty database this page is honest scaffolding,
 * and with real data it fills in without a single line changing here.
 * The one h1 on this route is the hero's.
 */
export default async function HomePage(): Promise<React.JSX.Element> {
  const [divisions, teams, results, news, partners, recruitment, socials] = await Promise.all([
    getPublicDivisions(),
    getPublicTeams(),
    getPublicResults(),
    getPublishedNews(),
    getPublishedPartners(),
    getRecruitment(),
    getSiteSocials(),
  ]);

  const facts =
    divisions === null || teams === null || results === null
      ? null
      : { divisions: divisions.length, teams: teams.length, results: results.length };

  return (
    <>
      <Hero />
      <ProofStrip facts={facts} />
      <Divisions data={divisions} />
      <Roster data={teams} />
      <Results data={results} />
      <NewsFeed data={news} />
      <About />
      <Community data={socials} />
      <Recruitment data={recruitment} />
      <Partners data={partners} />
    </>
  );
}
