import type { Display, Point } from "@ios-sim/protocol";

export type CoordinateUnit = "point" | "pixel" | "normalized";

export function toNormalizedPoint(
  x: number,
  y: number,
  unit: CoordinateUnit,
  display: Pick<Display, "widthPx" | "heightPx" | "widthPoints" | "heightPoints">,
): Point {
  if (!["point", "pixel", "normalized"].includes(unit)) {
    throw new Error("--unit must be point, pixel, or normalized.");
  }
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new Error("Coordinates must be finite numbers.");
  }
  const width = unit === "point" ? display.widthPoints : unit === "pixel" ? display.widthPx : 1;
  const height = unit === "point" ? display.heightPoints : unit === "pixel" ? display.heightPx : 1;
  const point = { x: x / width, y: y / height };
  if (point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1) {
    throw new Error(`Coordinates (${x}, ${y}) fall outside the ${unit} display bounds.`);
  }
  return point;
}
