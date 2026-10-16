import { getPayload } from "payload";

import config from "@raptor/cms/config";

import { toArticle, toPartner } from "./cms-view";

/**
 * Published CMS reads for the public site.
 *
 * Local API, no user, `overrideAccess` left at its default (`false`): every
 * query is filtered by the collection access rules in `@raptor/cms`, so a
 * draft is invisible here by database-shaped enforcement, not by omitting it
 * from the markup. Like `server/public.ts`, everything degrades to `null`
 * (unknown) instead of throwing — the e2e suite runs with no database at all.
 *
 * Rows cross the boundary through the narrow mappers in `./cms-view`: only
 * the fields the public site renders are named, so a future CMS field
 * (notes, emails, internal flags) cannot leak into markup by accident.
 */

export interface CmsArticle {
  readonly title: string;
  readonly slug: string;
  readonly excerpt: string | null;
  readonly publishedAt: string | null;
}

export interface CmsPartner {
  readonly name: string;
  readonly url: string | null;
  readonly tier: string;
}

export interface CmsRecruitment {
  readonly open: boolean;
  readonly heading: string | null;
  readonly formTarget: string | null;
}

/**
 * One Payload instance per server process, shared by every CMS read in a
 * request. Initialisation opens its own pools and runs metadata queries, so
 * four concurrent `getPayload()` calls quadruple a multi-second cold start —
 * slow enough that the streamed page stalls in its skeleton state. Sharing
 * one initialisation is the whole fix; a failed one clears itself so the next
 * request retries instead of caching the failure forever.
 */
let payloadPromise: Promise<Awaited<ReturnType<typeof getPayload>>> | null = null;

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Payload init exceeded ${String(ms)}ms`));
    }, ms);
  });
  return Promise.race([work, timeout]).finally(() => {
    clearTimeout(timer);
  });
}

async function cms(): Promise<Awaited<ReturnType<typeof getPayload>> | null> {
  if (payloadPromise === null) {
    payloadPromise = getPayload({ config }).catch((error: unknown) => {
      payloadPromise = null;
      throw error;
    });
  }
  try {
    return await withTimeout(payloadPromise, 20_000);
  } catch {
    return null;
  }
}

export async function getPublishedNews(limit = 4): Promise<readonly CmsArticle[] | null> {
  const payload = await cms();
  if (payload === null) return null;
  try {
    const result = await payload.find({
      collection: "cms_news",
      where: { _status: { equals: "published" } },
      sort: "-publishedAt",
      limit,
      depth: 0,
    });
    return result.docs.map(toArticle);
  } catch {
    return null;
  }
}

export async function getPublishedPartners(): Promise<readonly CmsPartner[] | null> {
  const payload = await cms();
  if (payload === null) return null;
  try {
    const result = await payload.find({
      collection: "cms_partners",
      where: { _status: { equals: "published" } },
      sort: "name",
      limit: 24,
      depth: 0,
    });
    return result.docs.map(toPartner);
  } catch {
    return null;
  }
}

interface RecruitmentRow {
  readonly open?: boolean | null;
  readonly heading?: string | null;
  readonly formTarget?: string | null;
}

export async function getRecruitment(): Promise<CmsRecruitment | null> {
  const payload = await cms();
  if (payload === null) return null;
  try {
    const row: RecruitmentRow = await payload.findGlobal({ slug: "cms_recruitment", depth: 0 });
    return {
      open: row.open ?? false,
      heading: row.heading ?? null,
      formTarget: row.formTarget ?? null,
    };
  } catch {
    return null;
  }
}

export interface CmsSocial {
  readonly network: string;
  readonly url: string;
}

interface SiteSettingsRow {
  readonly siteName?: string | null;
  readonly socials?: readonly { network?: string | null; url?: string | null }[] | null;
}

/** Verified social channels for the community section. Empty, never invented. */
export async function getSiteSocials(): Promise<readonly CmsSocial[] | null> {
  const payload = await cms();
  if (payload === null) return null;
  try {
    const row: SiteSettingsRow = await payload.findGlobal({ slug: "cms_site_settings", depth: 0 });
    const socials = row.socials ?? [];
    return socials
      .filter(
        (entry): entry is { network: string; url: string } =>
          typeof entry.network === "string" &&
          entry.network !== "" &&
          typeof entry.url === "string" &&
          entry.url !== "",
      )
      .map((entry) => ({ network: entry.network, url: entry.url }));
  } catch {
    return null;
  }
}
