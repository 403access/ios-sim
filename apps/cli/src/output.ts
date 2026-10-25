export function printTable(
  rows: Array<Record<string, string>>,
  columns: Array<{ key: string; label: string }>,
): string {
  if (rows.length === 0) return "";
  const widths = columns.map((column) =>
    Math.max(column.label.length, ...rows.map((row) => (row[column.key] ?? "").length)),
  );
  const header = columns.map((column, index) => column.label.padEnd(widths[index] ?? 0)).join("  ");
  const divider = widths.map((width) => "-".repeat(width)).join("  ");
  const body = rows.map((row) =>
    columns.map((column, index) => (row[column.key] ?? "").padEnd(widths[index] ?? 0)).join("  "),
  );
  return [header, divider, ...body].join("\n");
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
