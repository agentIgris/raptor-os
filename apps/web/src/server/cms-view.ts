import type { CmsArticle, CmsPartner } from "./cms";

interface NewsRow {
  readonly title: string;
  readonly slug: string;
  readonly excerpt?: string | null;
  readonly publishedAt?: string | null;
}

export function toArticle(doc: unknown): CmsArticle {
  const row = doc as NewsRow;
  return {
    title: row.title,
    slug: row.slug,
    excerpt: row.excerpt ?? null,
    publishedAt: row.publishedAt ?? null,
  };
}

interface PartnerRow {
  readonly name: string;
  readonly url?: string | null;
  readonly tier?: string | null;
}

export function toPartner(doc: unknown): CmsPartner {
  const row = doc as PartnerRow;
  return {
    name: row.name,
    url: row.url ?? null,
    tier: row.tier ?? "community",
  };
}
