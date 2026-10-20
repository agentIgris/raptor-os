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
    <section
      aria-labelledby="home-hero"
      className="dc-bg-void dc-grid relative overflow-hidden border-b-2 border-b-[var(--dc-line)]"
    >
      <div className="dc-mesh absolute inset-0" aria-hidden="true" />
      <div className="absolute inset-0" aria-hidden="true">
        <Image
          src="/placeholders/hero.png"
          alt=""
          width={1920}
          height={1080}
          priority
          sizes="100vw"
          className="h-full w-full object-cover opacity-10"
        />
      </div>
      <div className="relative mx-auto flex w-full max-w-6xl flex-col gap-5 px-4 py-20 md:px-8 md:py-28">
        <span className="dc-fill-sun dc-hard-violet inline-flex w-fit -rotate-2 items-center gap-1 rounded-full border-2 border-[var(--dc-on-pop)] px-3 py-1 text-xs font-bold tracking-[var(--tracking-wide)] uppercase">
          Raptor Esports
          <span aria-hidden="true" className="dc-spinslow text-base leading-none">
            ✦
          </span>
        </span>
        <h1
          id="home-hero"
          className="font-display max-w-prose text-balance text-[length:var(--text-4xl)] leading-[var(--leading-tight)] font-black break-words md:text-[4.5rem]"
        >
          <span className="dc-hot dc-text-stack">Raptor</span>
          <br />
          <span className="dc-cyan">Esports</span>
        </h1>
        <p className="max-w-prose text-pretty text-[length:var(--text-md)] leading-[var(--leading-normal)] text-[var(--dc-ink-dim)]">
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
