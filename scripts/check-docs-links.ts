#!/usr/bin/env bun
/**
 * Docs link gate (REL-005).
 *
 * Checks relative Markdown links in docs-site/docs and root markdown files.
 * External URLs and pure anchors are skipped; a missing target fails the gate.
 * Docusaurus also runs with onBrokenLinks/onBrokenMarkdownLinks = throw.
 *
 * Usage:
 *   bun scripts/check-docs-links.ts
 *   bun scripts/check-docs-links.ts --json
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

interface BrokenLink {
  file: string;
  link: string;
  target: string;
}

function markdownFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (path: string): void => {
    for (const entry of readdirSync(path)) {
      if (entry === "node_modules" || entry === "build" || entry.startsWith(".")) continue;
      const full = join(path, entry);
      if (statSync(full).isDirectory()) visit(full);
      else if (entry.endsWith(".md")) files.push(full);
    }
  };
  if (existsSync(root)) visit(root);
  return files;
}

function checkFile(file: string): BrokenLink[] {
  const text = readFileSync(file, "utf8");
  const broken: BrokenLink[] = [];
  const pattern = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  for (const match of text.matchAll(pattern)) {
    const link = match[1]!;
    if (/^(https?:|mailto:|tel:|#)/.test(link)) continue;
    const withoutAnchor = link.split("#")[0]!;
    if (withoutAnchor.length === 0) continue;
    const target = resolve(dirname(file), withoutAnchor);
    const ok =
      existsSync(target) ||
      existsSync(`${target}.md`) ||
      existsSync(join(target, "index.md")) ||
      existsSync(join(target, "README.md"));
    if (!ok) broken.push({ file: relative(process.cwd(), file), link, target });
  }
  return broken;
}

function main(): number {
  const json = process.argv.slice(2).includes("--json");
  const files = [
    ...markdownFiles("docs-site/docs"),
    ...markdownFiles(".").filter((file) => dirname(file) === "."),
  ];
  const broken = files.flatMap(checkFile);
  if (json) {
    console.log(JSON.stringify({ files: files.length, broken }, null, 2));
  } else if (broken.length === 0) {
    console.log(`docs links: ${files.length} files checked, no broken relative links`);
  } else {
    for (const entry of broken) {
      console.error(`${entry.file}: ${entry.link} -> ${entry.target}`);
    }
    console.error(`docs links: ${broken.length} broken link(s) in ${files.length} files`);
  }
  return broken.length === 0 ? 0 : 1;
}

process.exit(main());
