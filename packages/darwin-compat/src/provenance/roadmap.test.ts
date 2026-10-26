import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { validateRoadmap } from "./roadmap.js";

const BACKLOG = "docs-site/docs/roadmaps/native/backlog.md";

describe("roadmap validator", () => {
  it("accepts the current backlog", () => {
    const report = validateRoadmap(readFileSync(resolve(process.cwd(), BACKLOG), "utf8"));
    expect(report.problems).toEqual([]);
    expect(report.readyIds.length).toBeGreaterThan(0);
    expect(report.nextIds).toHaveLength(1);
  });

  it("catches duplicates, done-in-queue, and missing status", () => {
    const text = [
      "## 2. Ready queue",
      "| Order | ID | Workstream | Size | Depends | Deliverable |",
      "| ----: | -- | ---------- | ---- | ------- | ----------- |",
      "| 1 | `A-1` | X | S | A0 | one |",
      "| 2 | `A-1` | X | S | A0 | duplicate |",
      "| 3 | `B-2` | X | S | A0 | missing status |",
      "### Next sessions",
      "| 1 | `A-1` | `Z-9` | outcome |",
      "## 3. Scheduled tasks",
      "| ID | Task | Priority | Size | Status | Depends | Acceptance |",
      "| -- | ---- | -------- | ---- | ------ | ------- | ---------- |",
      "| `A-1` | done | P0 | S | **done** | A0 | ok |",
    ].join("\n");
    const report = validateRoadmap(text);
    const messages = report.problems.map((problem) => problem.message).join("\n");
    expect(messages).toContain("appears more than once");
    expect(messages).toContain("marked done but still in the ready queue");
    expect(messages).toContain("B-2 is in the ready queue but has no status row");
    expect(messages).toContain("no task is marked next");
  });
});
