import type { Orientation, RoadSegment } from "./types";

export interface GridPoint {
  x: number;
  y: number;
}

export const getRoadEndpoints = ({
  x,
  y,
  orientation
}: Pick<RoadSegment, "x" | "y" | "orientation">): [GridPoint, GridPoint] =>
  orientation === "horizontal"
    ? [
        { x, y },
        { x: x + 1, y }
      ]
    : [
        { x, y },
        { x, y: y + 1 }
      ];

export const getRoadEdgeKey = (
  segment: Pick<RoadSegment, "x" | "y" | "orientation">
) => {
  const [from, to] = getRoadEndpoints(segment);
  return `${from.x},${from.y}:${to.x},${to.y}`;
};

export const getNormalizedEdgeKey = (
  fromX: number,
  fromY: number,
  toX: number,
  toY: number
) => {
  if (fromX < toX || (fromX === toX && fromY <= toY)) {
    return `${fromX},${fromY}:${toX},${toY}`;
  }

  return `${toX},${toY}:${fromX},${fromY}`;
};

export const getRoadNodeKey = (x: number, y: number) => `${x},${y}`;

export const getAdjacentRoadKeysForCell = (x: number, y: number) => ({
  top: getRoadSegmentKey(x, y, "horizontal"),
  bottom: getRoadSegmentKey(x, y + 1, "horizontal"),
  left: getRoadSegmentKey(x, y, "vertical"),
  right: getRoadSegmentKey(x + 1, y, "vertical")
});

export const getRoadSegmentKey = (
  x: number,
  y: number,
  orientation: Orientation
) => `${orientation}:${x},${y}`;
