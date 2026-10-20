#!/usr/bin/env node
/**
 * scripts/check-doc-links.mjs — every relative link in the documentation resolves.
 *
 * WHY THIS IS A GATE AND NOT A CONVENIENCE
 * ------------------------------------------
 * A broken link in a README is a small lie: it promises a document that is not
 * there, and a reader who follows it concludes that the thing does not exist.
 * It is also invisible to every other gate — the tests do not read Markdown,
 * the linter does not follow links, and a link only breaks when a file is
 * MOVED, which is exactly when nobody is looking at the documentation.
 *
 * Two links in this repository were broken that way when this gate was added:
 * two ADRs pointed at `0007-better-auth-self-hosted.md` when the file is
 * `0007-self-hosted-better-auth.md`. The ADRs were correct when they were
 * written; a rename broke them silently.
 *
 * WHAT IT CHECKS
 * --------------
 * Every Markdown file in the repository, and every relative link in it:
 * `](path)`, with the anchor (`#section`) stripped. External links
 * (`https:`, `mailto:`) are not fetched — a link checker that depends on the
 * network is a link checker that fails when the network does.
 *
 * The check is deliberately quiet about anchors: an anchor that does not
 * resolve is a broken link in a browser, but the set of valid headings
 * changes with every wording tweak, and a false positive here would train
 * people to ignore the gate.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const IGNORED_DIRECTORIES = new Set([
  "node_modules",
  ".git",
  ".next",
  ".turbo",
  ".data",
  ".vercel",
  "dist",
  "coverage",
  "playwright-report",
  "test-results",
]);

function markdownFiles(directory, found = []) {
  for (const entry of readdirSync(directory)) {
    if (IGNORED_DIRECTORIES.has(entry)) continue;
    const full = path.join(directory, entry);
    let stats;
    try {
      stats = statSync(full);
    } catch {
      continue;
    }
    if (stats.isDirectory()) markdownFiles(full, found);
    else if (entry.endsWith(".md")) found.push(full);
  }
  return found;
}

const files = markdownFiles(repoRoot);
let checked = 0;
const broken = [];

for (const file of files) {
  const text = readFileSync(file, "utf8");
  const relative = path.relative(repoRoot, file).split(path.sep).join("/");
  const links = [...text.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)].map((match) => match[1]);

  for (const link of links) {
    if (/^(https?:|mailto:|#)/.test(link)) continue;
    const [target] = link.split("#");
    if (target === "") continue;
    checked += 1;
    const absolute = path.resolve(path.dirname(file), decodeURIComponent(target));
    if (!exists(absolute)) broken.push(`${relative} -> ${link}`);
  }
}

/** `existsSync` without the exception noise, because a link may point at a directory. */
function exists(target) {
  try {
    statSync(target);
    return true;
  } catch {
    return false;
  }
}

if (broken.length > 0) {
  console.error(`\ncheck-doc-links: ${broken.length} broken link(s):\n`);
  for (const entry of broken) console.error(`  ${entry}`);
  console.error(`\nchecked ${checked} relative links across ${files.length} Markdown files\n`);
  process.exit(1);
}

console.log(`check-doc-links: ${checked} relative links across ${files.length} Markdown files — all resolve.`);
