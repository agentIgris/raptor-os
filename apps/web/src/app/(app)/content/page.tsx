import type { Metadata } from "next";
import * as React from "react";

import { Button, EmptyState, PageHeader, Table, TableBody, TableCaption, TableCell, TableHead, TableHeaderCell, TableRow, TableRowHeader } from "@raptor/ui";

import { getPublishedNews } from "../../../server/cms";

export const metadata: Metadata = {
  title: "Content",
};

export const dynamic = "force-dynamic";

/**
 * Published content pipeline at a glance. Drafts live in `/cms-admin` —
 * this surface lists what the public can already see, plus the way in.
 * (Draft visibility here would need a CMS-operator session, which product
 * users do not have until Task 9 unifies identity.)
 */
export default async function ContentPage(): Promise<React.JSX.Element> {
  const articles = await getPublishedNews(50);

  return (
    <>
      <PageHeader
        eyebrow="Content"
        title="Published stories"
        description="What the public site shows right now."
        actions={
          <Button asChild variant="outline">
            <a href="/cms-admin">Open content admin</a>
          </Button>
        }
      />
      <div className="mx-auto flex w-full max-w-6xl min-w-0 flex-col gap-8 px-4 py-6 md:px-8 md:py-8">
        {articles === null ? (
          <EmptyState title="Content unavailable" description="Could not load published stories right now. Try again later." />
        ) : articles.length === 0 ? (
          <EmptyState title="Nothing published yet" description="Stories appear here once the first article is published from the content admin." />
        ) : (
          <Table label="Published stories">
            <TableCaption>Newest first. Drafts never appear here.</TableCaption>
            <TableHead>
              <TableRow>
                <TableHeaderCell scope="col">Title</TableHeaderCell>
                <TableHeaderCell scope="col">Slug</TableHeaderCell>
                <TableHeaderCell scope="col">Published</TableHeaderCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {articles.map((article) => (
                <TableRow key={article.slug}>
                  <TableRowHeader>{article.title}</TableRowHeader>
                  <TableCell className="font-mono text-[length:var(--text-xs)] break-all" translate="no">
                    {article.slug}
                  </TableCell>
                  <TableCell className="tabular-nums">
                    {article.publishedAt === null ? "—" : article.publishedAt.slice(0, 10)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </>
  );
}
