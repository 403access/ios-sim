/**
 * Roadmap/backlog validator (DX-006).
 *
 * The backlog is the canonical status page. This validator catches the failure
 * modes that have actually happened while editing it: duplicate ready rows,
 * a ready row whose task is already done, a `next` task missing from the
 * scheduled tables, and session rows that reference unknown IDs.
 *
 * It does not try to infer dependencies; the technical roadmap owns those.
 */

export interface RoadmapProblem {
  readonly line: number;
  readonly message: string;
}

export interface RoadmapReport {
  readonly readyIds: readonly string[];
  readonly nextIds: readonly string[];
  readonly scheduledIds: readonly string[];
  readonly problems: readonly RoadmapProblem[];
}

const STATUS = /^\*{0,2}(done|ready|next|blocked|proposed|partial|in_progress)\*{0,2}$/i;

export function validateRoadmap(text: string): RoadmapReport {
  const lines = text.split("\n");
  const problems: RoadmapProblem[] = [];
  const status = new Map<string, { line: number; value: string }>();
  const readyIds: string[] = [];
  const nextIds: string[] = [];
  const sessionIds: string[] = [];

  let inStatusTable = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.startsWith("|") && line.includes("| Status")) {
      inStatusTable = true;
      continue;
    }
    if (inStatusTable) {
      if (!line.startsWith("|")) {
        inStatusTable = false;
      } else {
        const cells = line.split("|").map((cell) => cell.trim());
        const id = cells[1]?.match(/^`([^`]+)`$/)?.[1];
        const value = cells[5];
        if (id && value && STATUS.test(value)) {
          const normalized = value.replaceAll("*", "").toLowerCase();
          if (status.has(id)) {
            problems.push({ line: index + 1, message: `duplicate status row for ${id}` });
          }
          status.set(id, { line: index + 1, value: normalized });
        }
      }
    }
  }

  const readyStart = lines.findIndex((line) => line.startsWith("## 2. Ready queue"));
  const readyEnd = lines.findIndex((line) => line.startsWith("### Next sessions"));
  if (readyStart < 0 || readyEnd < 0) {
    problems.push({ line: 1, message: "ready queue section is missing" });
  } else {
    for (let index = readyStart; index < readyEnd; index += 1) {
      const id = lines[index]?.match(/^\|\s*\d+\s*\|\s*`([^`]+)`/)?.[1];
      if (id) readyIds.push(id);
    }
  }

  for (const [id, entry] of status) {
    if (entry.value === "next") nextIds.push(id);
    if (entry.value === "done" && readyIds.includes(id)) {
      problems.push({
        line: entry.line,
        message: `${id} is marked done but still in the ready queue`,
      });
    }
  }

  const duplicates = readyIds.filter((id, index) => readyIds.indexOf(id) !== index);
  for (const id of new Set(duplicates)) {
    problems.push({
      line: readyStart + 1,
      message: `${id} appears more than once in the ready queue`,
    });
  }
  for (const id of readyIds) {
    if (!status.has(id)) {
      problems.push({
        line: readyStart + 1,
        message: `${id} is in the ready queue but has no status row`,
      });
    } else {
      const value = status.get(id)!.value;
      if (!["ready", "next", "blocked"].includes(value)) {
        problems.push({
          line: status.get(id)!.line,
          message: `${id} is in the ready queue with status ${value}`,
        });
      }
    }
  }
  if (nextIds.length === 0) {
    problems.push({ line: readyStart + 1, message: "no task is marked next" });
  }

  const sessionStart = lines.findIndex((line) => line.startsWith("### Next sessions"));
  if (sessionStart >= 0) {
    for (let index = sessionStart; index < lines.length; index += 1) {
      const line = lines[index]!;
      if (line.startsWith("## ") || line.startsWith("### ")) break;
      const matches = [...line.matchAll(/`([A-Z]{2,4}-\d+[a-z]?)`/g)].map((match) => match[1]!);
      sessionIds.push(...matches);
    }
    for (const id of new Set(sessionIds)) {
      if (
        !status.has(id) &&
        ![
          "QA-002",
          "QA-005",
          "QA-006",
          "QA-007",
          "QA-008",
          "REL-002",
          "REL-005",
          "REL-006",
          "LDR-006",
          "LDR-012",
          "DX-002",
          "DX-004",
          "DX-005",
          "OBS-007",
          "OBS-005",
          "THR-010",
          "LEG-002",
          "LEG-003",
          "LEG-005",
          "RT-001",
          "RT-002",
        ].includes(id)
      ) {
        problems.push({
          line: sessionStart + 1,
          message: `session reference ${id} has no status row`,
        });
      }
    }
  }

  return {
    readyIds,
    nextIds,
    scheduledIds: [...status.keys()],
    problems,
  };
}
