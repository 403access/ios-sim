/**
 * Claims audit (LEG-004).
 *
 * The project must not drift into advertising a simulator port. This is a
 * small, explicit rule set for the phrasing that has actually caused confusion:
 * "the bridge runs iOS", "ships a simulator", "Apple UIKit runs", or "natively
 * on Linux" without a negation.
 *
 * It is not a general fact checker. Its job is to catch regressions in the
 * wording while the provenance ledger carries the detailed evidence.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export interface ClaimRule {
  readonly id: string;
  readonly pattern: RegExp;
  readonly message: string;
}

export interface ClaimFinding {
  readonly file: string;
  readonly line: number;
  readonly rule: string;
  readonly message: string;
  readonly excerpt: string;
}

const NEGATION = /\b(not|never|cannot|can't|does not|doesn't|do not|don't|isn't|is not)\b/i;

export const CLAIM_RULES: readonly ClaimRule[] = [
  {
    id: "runs-ios",
    pattern:
      /\b(this|the)\s+(project|bridge|native track|repo|repository|layer|substrate|cli)\s+(runs|boots|executes)\s+(iOS|Apple)\b/gi,
    message: "the substrate does not run iOS or Apple binaries",
  },
  {
    id: "ships-simulator",
    pattern: /\bships an iOS Simulator:\s*yes\b/gi,
    message: "the native track does not ship an iOS Simulator",
  },
  {
    id: "simulator-native-linux",
    pattern: /\b(iOS Simulator|simulator|Apple runtime)\b[^.\n]{0,60}\bnatively on Linux\b/gi,
    message: "the iOS Simulator does not run natively on Linux",
  },
  {
    id: "apple-uikit-runs",
    pattern: /\bApple UIKit\b[^.\n]{0,40}\b(runs|executes|is runnable|works)\b/gi,
    message: "Apple UIKit is not runnable without licensed frameworks",
  },
  {
    id: "full-simulator",
    pattern: /\bis a (full|complete|working) iOS Simulator\b/gi,
    message: "this is a research substrate, not a simulator",
  },
];

export function auditClaims(text: string, file = "<text>"): ClaimFinding[] {
  const findings: ClaimFinding[] = [];
  const lines = text.split("\n");
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex]!;
    for (const rule of CLAIM_RULES) {
      rule.pattern.lastIndex = 0;
      for (const match of line.matchAll(rule.pattern)) {
        const start = Math.max(0, (match.index ?? 0) - 60);
        const end = (match.index ?? 0) + match[0].length;
        const context = line.slice(start, end);
        if (NEGATION.test(context)) continue;
        findings.push({
          file,
          line: lineIndex + 1,
          rule: rule.id,
          message: rule.message,
          excerpt: line.trim().slice(0, 160),
        });
      }
    }
  }
  return findings;
}

function auditable(file: string): boolean {
  if (file.endsWith(".test.ts")) return false;
  if (file === "claims.ts") return false;
  return file.endsWith(".md") || file.endsWith(".ts");
}

export function auditRepository(root = process.cwd()): ClaimFinding[] {
  const files: string[] = [];
  const visit = (path: string): void => {
    for (const entry of readdirSync(path)) {
      if (["node_modules", "build", "dist", "coverage"].includes(entry) || entry.startsWith(".")) continue;
      const full = join(path, entry);
      if (statSync(full).isDirectory()) visit(full);
      else if (auditable(entry)) files.push(full);
    }
  };
  for (const entry of readdirSync(root)) {
    if (["node_modules", "build", "dist", "coverage"].includes(entry) || entry.startsWith(".")) continue;
    const full = join(root, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "docs-site" || entry === "apps" || entry === "packages") visit(full);
    } else if (auditable(entry)) {
      files.push(full);
    }
  }
  const findings: ClaimFinding[] = [];
  for (const file of files) {
    findings.push(...auditClaims(readFileSync(file, "utf8"), relative(root, file)));
  }
  return findings;
}

export function formatClaimFindings(findings: readonly ClaimFinding[]): string {
  if (findings.length === 0) return "claims audit: no false simulator claims";
  return findings
    .map(
      (finding) =>
        `${finding.file}:${finding.line} [${finding.rule}] ${finding.message}\n  ${finding.excerpt}`,
    )
    .join("\n");
}
