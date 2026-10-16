import Image from "next/image";
import * as React from "react";

import { Button } from "@raptor/ui";

/**
 * Public hero: identity first, claims never.
 *
 * The artwork is the placeholder until an authorized Raptor photo lands in
 * the manifest. The copy states the editorial contract (verified content
 * only) rather than any achievement — with an empty database every number on
 * this page would otherwise be a fabrication.
 */
export function Hero(): React.JSX.Element {
  return (
    <section aria-labelledby="home-hero" className="relative overflow-hidden border-b border-hairline">
      <div className="absolute inset-0" aria-hidden="true">
        <Image
          src="/placeholders/hero.png"
          alt=""
          width={1920}
          height={1080}
          priority
          sizes="100vw"
          className="h-full w-full object-cover"
        />
        <div className="absolute inset-0 bg-canvas/72" />
      </div>
      <div className="relative mx-auto flex w-full max-w-6xl flex-col gap-5 px-4 py-20 md:px-8 md:py-28">
        <p
          className="text-[length:var(--text-xs)] font-semibold tracking-[var(--tracking-wide)] text-ink-muted uppercase"
          translate="no"
        >
          Raptor Esports
        </p>
        <h1
          id="home-hero"
          className="font-display max-w-prose text-balance text-[length:var(--text-4xl)] leading-[var(--leading-tight)] font-semibold break-words text-ink md:text-[4.5rem]"
        >
          Raptor Esports
        </h1>
        <p className="max-w-prose text-pretty text-[length:var(--text-md)] leading-[var(--leading-normal)] text-ink-muted">
          Teams, verified results and news — published here as they happen. Nothing invented, nothing rumoured.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <Button asChild>
            <a href="#teams">Explore the teams</a>
          </Button>
          <Button asChild variant="outline">
            <a href="#results">Latest results</a>
          </Button>
        </div>
      </div>
    </section>
  );
}
