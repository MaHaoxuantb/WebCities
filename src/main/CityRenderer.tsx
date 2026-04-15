import { useEffect, useRef } from "react";
import { Application, Container, Graphics } from "pixi.js";

import { CELL_SIZE, WORLD_HEIGHT, WORLD_WIDTH } from "../shared/constants";
import {
  getNormalizedEdgeKey,
  getRoadEdgeKey,
  getRoadEndpoints,
  getRoadNodeKey,
  getRoadSegmentKey
} from "../shared/roadGeometry";
import type {
  OverlayKind,
  Orientation,
  SimSnapshot,
  ToolMode,
  ZoneType
} from "../shared/types";

type RoadTarget = {
  x: number;
  y: number;
  orientation: Orientation;
  distance: number;
};

type RoundaboutVisual = {
  centerX: number;
  centerY: number;
  utilization: number;
};

type JunctionVisual = {
  x: number;
  y: number;
  utilization: number;
};

type CanvasAction =
  | {
      type: "road";
      x: number;
      y: number;
      orientation: Orientation;
      mode: "add" | "remove";
    }
  | {
      type: "junction";
      centerCellX: number;
      centerCellY: number;
    }
  | {
      type: "bulldoze";
      cellX: number;
      cellY: number;
      road?: { x: number; y: number; orientation: Orientation } | null;
    }
  | { type: "zone"; x: number; y: number; zoneType: ZoneType | null }
  | { type: "service"; x: number; y: number; kind: "power" };

interface CityRendererProps {
  snapshot: SimSnapshot | null;
  overlay: OverlayKind;
  tool: ToolMode;
  theme: "dark" | "light";
  onAction: (action: CanvasAction) => void;
}

export type { CanvasAction };

interface CameraState {
  x: number;
  y: number;
  zoom: number;
}

const ROAD_HIT_THRESHOLD = 0.24;
const ROAD_OUTER_WIDTH = 12;
const ROAD_INNER_WIDTH = 6;
const ROAD_SEGMENT_STYLE = { cap: "butt" as const, join: "miter" as const };
const ROAD_RING_STYLE = { cap: "round" as const, join: "round" as const };

interface ThemePalette {
  sceneBackground: number;
  grid: number;
  roadShell: number;
  roadNeutral: number;
  queue: number;
  buildingNeutral: number;
  powerPlant: number;
  powered: number;
  unpowered: number;
  outageCross: number;
  vehicleNeutral: number;
  vehicleTruck: number;
  vehicleService: number;
  vehicleVan: number;
}

const themePalette: Record<"dark" | "light", ThemePalette> = {
  dark: {
    sceneBackground: 0x20252a,
    grid: 0x2b3137,
    roadShell: 0x161b1f,
    roadNeutral: 0x79838d,
    queue: 0x9d7758,
    buildingNeutral: 0xaeb6bc,
    powerPlant: 0x7d93a1,
    powered: 0x8b9c73,
    unpowered: 0xa26762,
    outageCross: 0x8f625d,
    vehicleNeutral: 0xcfd5db,
    vehicleTruck: 0xc39554,
    vehicleService: 0x6ea6cf,
    vehicleVan: 0xa4c27e
  },
  light: {
    sceneBackground: 0xf2efe8,
    grid: 0xd5cfc2,
    roadShell: 0x5e5a53,
    roadNeutral: 0x8b95a1,
    queue: 0xc08a5d,
    buildingNeutral: 0x81909c,
    powerPlant: 0x5e8197,
    powered: 0x7d9a63,
    unpowered: 0xbd695d,
    outageCross: 0x9f5b52,
    vehicleNeutral: 0x4e5962,
    vehicleTruck: 0xaf7b32,
    vehicleService: 0x4a86ba,
    vehicleVan: 0x6f9160
  }
};

const zonePalette: Record<ZoneType, number> = {
  residential: 0x708e70,
  commercial: 0x7085a5,
  industrial: 0x9a7d5d
};

const pickRoadTarget = (gridX: number, gridY: number): RoadTarget => {
  const cellX = Math.floor(gridX);
  const cellY = Math.floor(gridY);
  const localX = gridX - cellX;
  const localY = gridY - cellY;
  const distances = [
    { orientation: "vertical" as const, x: cellX, y: cellY, distance: localX },
    {
      orientation: "vertical" as const,
      x: cellX + 1,
      y: cellY,
      distance: 1 - localX
    },
    {
      orientation: "horizontal" as const,
      x: cellX,
      y: cellY,
      distance: localY
    },
    {
      orientation: "horizontal" as const,
      x: cellX,
      y: cellY + 1,
      distance: 1 - localY
    }
  ];

  distances.sort((a, b) => a.distance - b.distance);
  return distances[0];
};

const overlayRoadColor = (utilization: number) => {
  if (utilization > 1) {
    return 0xbd695d;
  }

  if (utilization > 0.7) {
    return 0xc08a5d;
  }

  if (utilization > 0.35) {
    return 0xc1b17a;
  }

  return 0x8d9ca7;
};

const happinessColor = (happiness: number) => {
  if (happiness < 0.25) {
    return 0x8b5a5f;
  }

  if (happiness < 0.5) {
    return 0xa97a54;
  }

  if (happiness < 0.75) {
    return 0xa4a07a;
  }

  return 0x7f9683;
};

const drawRoadStroke = (
  scene: Graphics,
  road: SimSnapshot["roads"][number],
  width: number,
  color: number
) => {
  const [from, to] = getRoadEndpoints(road);
  scene
    .moveTo(from.x * CELL_SIZE, from.y * CELL_SIZE)
    .lineTo(to.x * CELL_SIZE, to.y * CELL_SIZE)
    .stroke({
      width,
      color,
      alpha: 1,
      ...ROAD_SEGMENT_STYLE
    });
};

const detectRoundabouts = (
  roads: SimSnapshot["roads"],
  utilizationByKey: Map<string, number>
) => {
  const roadKeys = new Set(
    roads.map((road) => getRoadSegmentKey(road.x, road.y, road.orientation))
  );
  const roundabouts: RoundaboutVisual[] = [];

  for (let centerX = 1; centerX < WORLD_WIDTH; centerX += 1) {
    for (let centerY = 1; centerY < WORLD_HEIGHT; centerY += 1) {
      const ringSegments = [
        { orientation: "horizontal" as const, x: centerX - 1, y: centerY - 1 },
        { orientation: "horizontal" as const, x: centerX, y: centerY - 1 },
        { orientation: "horizontal" as const, x: centerX - 1, y: centerY + 1 },
        { orientation: "horizontal" as const, x: centerX, y: centerY + 1 },
        { orientation: "vertical" as const, x: centerX - 1, y: centerY - 1 },
        { orientation: "vertical" as const, x: centerX - 1, y: centerY },
        { orientation: "vertical" as const, x: centerX + 1, y: centerY - 1 },
        { orientation: "vertical" as const, x: centerX + 1, y: centerY }
      ];

      if (
        !ringSegments.every((segment) =>
          roadKeys.has(getRoadSegmentKey(segment.x, segment.y, segment.orientation))
        )
      ) {
        continue;
      }

      const utilization =
        ringSegments.reduce((sum, segment) => {
          return sum + (utilizationByKey.get(getRoadEdgeKey(segment)) ?? 0);
        }, 0) / ringSegments.length;

      roundabouts.push({ centerX, centerY, utilization });
    }
  }

  return roundabouts;
};

const detectJunctions = (
  roads: SimSnapshot["roads"],
  utilizationByKey: Map<string, number>
) => {
  const nodeIncidents = new Map<
    string,
    {
      x: number;
      y: number;
      horizontal: number;
      vertical: number;
      utilization: number;
      segments: number;
    }
  >();

  const addIncident = (
    x: number,
    y: number,
    orientation: Orientation,
    utilization: number
  ) => {
    const key = getRoadNodeKey(x, y);
    const entry = nodeIncidents.get(key) ?? {
      x,
      y,
      horizontal: 0,
      vertical: 0,
      utilization: 0,
      segments: 0
    };
    if (orientation === "horizontal") {
      entry.horizontal += 1;
    } else {
      entry.vertical += 1;
    }
    entry.utilization += utilization;
    entry.segments += 1;
    nodeIncidents.set(key, entry);
  };

  for (const road of roads) {
    const utilization = utilizationByKey.get(getRoadEdgeKey(road)) ?? 0;
    const [start, end] = getRoadEndpoints(road);

    addIncident(start.x, start.y, road.orientation, utilization);
    addIncident(end.x, end.y, road.orientation, utilization);
  }

  return [...nodeIncidents.values()]
    .filter((entry) => entry.horizontal > 0 && entry.vertical > 0)
    .map<JunctionVisual>((entry) => ({
      x: entry.x,
      y: entry.y,
      utilization: entry.utilization / Math.max(entry.segments, 1)
    }));
};

export const CityRenderer = ({
  snapshot,
  overlay,
  tool,
  theme,
  onAction
}: CityRendererProps) => {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const appRef = useRef<Application | null>(null);
  const worldContainerRef = useRef<Container | null>(null);
  const graphicsRef = useRef<Graphics | null>(null);
  const drawSceneRef = useRef<(() => void) | null>(null);
  const scheduleRenderRef = useRef<(() => void) | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const snapshotRef = useRef<SimSnapshot | null>(snapshot);
  const overlayRef = useRef<OverlayKind>(overlay);
  const toolRef = useRef<ToolMode>(tool);
  const themeRef = useRef<"dark" | "light">(theme);
  const onActionRef = useRef(onAction);
  const cameraRef = useRef<CameraState>({ x: 56, y: 56, zoom: 1 });
  const spacePanRef = useRef(false);

  snapshotRef.current = snapshot;
  overlayRef.current = overlay;
  toolRef.current = tool;
  themeRef.current = theme;
  onActionRef.current = onAction;

  useEffect(() => {
    scheduleRenderRef.current?.();
  }, [snapshot, overlay, theme]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return;
    }

    let cancelled = false;
    const app = new Application();
    const worldContainer = new Container();
    const graphics = new Graphics();
    const camera = cameraRef.current;

    let isPanning = false;
    let panStartX = 0;
    let panStartY = 0;
    let dragDistance = 0;

    const screenToWorld = (screenX: number, screenY: number) => ({
      x: (screenX - camera.x) / camera.zoom,
      y: (screenY - camera.y) / camera.zoom
    });

    const drawScene = () => {
      const current = snapshotRef.current;
      if (!graphicsRef.current || !worldContainerRef.current) {
        return;
      }

      const scene = graphicsRef.current;
      const container = worldContainerRef.current;
      const palette = themePalette[themeRef.current];
      container.position.set(Math.round(camera.x), Math.round(camera.y));
      container.scale.set(camera.zoom);
      scene.clear();

      scene
        .rect(0, 0, CELL_SIZE * WORLD_WIDTH, CELL_SIZE * WORLD_HEIGHT)
        .fill(palette.sceneBackground);

      for (let x = 0; x <= CELL_SIZE * WORLD_WIDTH; x += CELL_SIZE) {
        scene
          .moveTo(x, 0)
          .lineTo(x, CELL_SIZE * WORLD_HEIGHT)
          .stroke({ width: 1, color: palette.grid, alpha: 1 });
      }
      for (let y = 0; y <= CELL_SIZE * WORLD_HEIGHT; y += CELL_SIZE) {
        scene
          .moveTo(0, y)
          .lineTo(CELL_SIZE * WORLD_WIDTH, y)
          .stroke({ width: 1, color: palette.grid, alpha: 1 });
      }

      if (!current) {
        return;
      }

      const roadUtilization = new Map<string, number>();
      for (const edge of current.edges) {
        const fromNode = current.nodes[edge.fromNodeId];
        const toNode = current.nodes[edge.toNodeId];
        const key = getNormalizedEdgeKey(fromNode.x, fromNode.y, toNode.x, toNode.y);
        roadUtilization.set(
          key,
          Math.max(edge.utilization, roadUtilization.get(key) ?? 0)
        );
      }

      const junctions = detectJunctions(current.roads, roadUtilization);

      for (const zone of current.zones) {
        scene
          .rect(zone.x * CELL_SIZE, zone.y * CELL_SIZE, CELL_SIZE, CELL_SIZE)
          .fill({ color: zonePalette[zone.zoneType], alpha: 0.16 });
      }

      for (const road of current.roads) {
        const utilization = roadUtilization.get(getRoadEdgeKey(road)) ?? 0;
        const roadColor =
          overlayRef.current === "traffic"
            ? overlayRoadColor(utilization)
            : palette.roadNeutral;

        drawRoadStroke(scene, road, ROAD_OUTER_WIDTH, palette.roadShell);
        drawRoadStroke(scene, road, ROAD_INNER_WIDTH, roadColor);
      }

      for (const junction of junctions) {
        const junctionColor =
          overlayRef.current === "traffic"
            ? overlayRoadColor(junction.utilization)
            : palette.roadNeutral;

        scene
          .circle(junction.x * CELL_SIZE, junction.y * CELL_SIZE, ROAD_OUTER_WIDTH / 2)
          .fill(palette.roadShell);
        scene
          .circle(junction.x * CELL_SIZE, junction.y * CELL_SIZE, ROAD_INNER_WIDTH / 2)
          .fill(junctionColor);
      }

      for (const roundabout of detectRoundabouts(current.roads, roadUtilization)) {
        const ringColor =
          overlayRef.current === "traffic"
            ? overlayRoadColor(roundabout.utilization)
            : palette.roadNeutral;

        scene
          .circle(
            roundabout.centerX * CELL_SIZE,
            roundabout.centerY * CELL_SIZE,
            CELL_SIZE * 0.95
          )
          .stroke({
            width: ROAD_OUTER_WIDTH + 2,
            color: palette.roadShell,
            alpha: 1,
            ...ROAD_RING_STYLE
          });
        scene
          .circle(
            roundabout.centerX * CELL_SIZE,
            roundabout.centerY * CELL_SIZE,
            CELL_SIZE * 0.95
          )
          .stroke({
            width: ROAD_INNER_WIDTH + 2,
            color: ringColor,
            alpha: 1,
            ...ROAD_RING_STYLE
          });
      }

      for (const node of current.nodes) {
        if (node.queueLength <= 0) {
          continue;
        }

        scene
          .circle(
            node.x * CELL_SIZE,
            node.y * CELL_SIZE,
            Math.min(16, 5 + node.queueLength)
          )
          .fill({ color: palette.queue, alpha: 0.55 });
      }

      for (const building of current.buildings) {
        let color = palette.buildingNeutral;
        if (building.kind === "powerPlant") {
          color = palette.powerPlant;
        } else if (overlayRef.current === "power") {
          color = building.powered ? palette.powered : palette.unpowered;
        } else if (overlayRef.current === "happiness") {
          color = happinessColor(building.happiness);
        } else if (building.kind in zonePalette) {
          color = zonePalette[building.kind as ZoneType];
        }

        scene
          .roundRect(
            building.cellX * CELL_SIZE + 5,
            building.cellY * CELL_SIZE + 5,
            CELL_SIZE - 10,
            CELL_SIZE - 10,
            7
          )
          .fill({ color, alpha: building.abandoned ? 0.3 : 0.82 });

        if (!building.powered && building.kind !== "powerPlant") {
          scene
            .moveTo(building.cellX * CELL_SIZE + 10, building.cellY * CELL_SIZE + 10)
            .lineTo(
              building.cellX * CELL_SIZE + CELL_SIZE - 10,
              building.cellY * CELL_SIZE + CELL_SIZE - 10
            )
            .stroke({ width: 2.5, color: palette.outageCross, alpha: 1 });
          scene
            .moveTo(
              building.cellX * CELL_SIZE + CELL_SIZE - 10,
              building.cellY * CELL_SIZE + 10
            )
            .lineTo(
              building.cellX * CELL_SIZE + 10,
              building.cellY * CELL_SIZE + CELL_SIZE - 10
            )
            .stroke({ width: 2.5, color: palette.outageCross, alpha: 1 });
        }
      }

      for (const vehicle of current.vehicles) {
        let fill = palette.vehicleNeutral;
        if (vehicle.spriteType === "truck") {
          fill = palette.vehicleTruck;
        } else if (vehicle.spriteType === "service") {
          fill = palette.vehicleService;
        } else if (vehicle.spriteType === "van") {
          fill = palette.vehicleVan;
        }

        const radius =
          vehicle.spriteType === "truck"
            ? 7.5
            : vehicle.spriteType === "service"
              ? 7
              : vehicle.spriteType === "van"
                ? 6.5
                : 6;

        scene
          .circle(vehicle.x * CELL_SIZE, vehicle.y * CELL_SIZE, radius)
          .fill({ color: fill, alpha: 0.95 });
      }
    };

    const scheduleRender = () => {
      if (animationFrameRef.current !== null) {
        return;
      }

      animationFrameRef.current = window.requestAnimationFrame(() => {
        animationFrameRef.current = null;
        if (!appRef.current || cancelled) {
          return;
        }

        drawSceneRef.current?.();
        appRef.current.render();
      });
    };

    const handlePointerDown = (event: PointerEvent) => {
      const wantsPan =
        event.button === 1 ||
        event.altKey ||
        spacePanRef.current;

      if (wantsPan) {
        isPanning = true;
        panStartX = event.clientX;
        panStartY = event.clientY;
        dragDistance = 0;
      } else {
        dragDistance = 0;
      }
    };

    const handlePointerMove = (event: PointerEvent) => {
      if (!isPanning) {
        return;
      }

      const dx = event.clientX - panStartX;
      const dy = event.clientY - panStartY;
      dragDistance += Math.abs(dx) + Math.abs(dy);
      camera.x += dx;
      camera.y += dy;
      panStartX = event.clientX;
      panStartY = event.clientY;
      scheduleRender();
    };

    const handlePointerUp = (event: PointerEvent) => {
      if (isPanning) {
        isPanning = false;
        return;
      }

      if (dragDistance > 4) {
        dragDistance = 0;
        return;
      }

      const rect = host.getBoundingClientRect();
      const world = screenToWorld(event.clientX - rect.left, event.clientY - rect.top);
      const gridX = world.x / CELL_SIZE;
      const gridY = world.y / CELL_SIZE;
      const cellX = Math.floor(gridX);
      const cellY = Math.floor(gridY);
      if (cellX < 0 || cellY < 0 || cellX >= WORLD_WIDTH || cellY >= WORLD_HEIGHT) {
        return;
      }

      const currentTool = toolRef.current;
      const roadTarget = pickRoadTarget(gridX, gridY);

      if (event.button === 2) {
        onActionRef.current({
          type: "bulldoze",
          cellX,
          cellY,
          road:
            roadTarget.distance <= ROAD_HIT_THRESHOLD
              ? {
                  x: roadTarget.x,
                  y: roadTarget.y,
                  orientation: roadTarget.orientation
                }
              : null
        });
        return;
      }

      if (currentTool === "road") {
        onActionRef.current({
          type: "road",
          x: roadTarget.x,
          y: roadTarget.y,
          orientation: roadTarget.orientation,
          mode: "add"
        });
        return;
      }

      if (currentTool === "junction-large") {
        const nodeX = Math.round(gridX);
        const nodeY = Math.round(gridY);
        onActionRef.current({
          type: "junction",
          centerCellX: nodeX,
          centerCellY: nodeY
        });
        return;
      }

      if (currentTool === "service-power") {
        onActionRef.current({
          type: "service",
          x: cellX,
          y: cellY,
          kind: "power"
        });
        return;
      }

      const zoneType =
        currentTool === "zone-residential"
          ? "residential"
          : currentTool === "zone-commercial"
            ? "commercial"
            : "industrial";
      onActionRef.current({ type: "zone", x: cellX, y: cellY, zoneType });
    };

    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = host.getBoundingClientRect();
      const pointerX = event.clientX - rect.left;
      const pointerY = event.clientY - rect.top;

      if (event.ctrlKey || event.metaKey) {
        const worldBefore = screenToWorld(pointerX, pointerY);
        const nextZoom = Math.max(
          0.45,
          Math.min(2.4, camera.zoom * Math.exp(-event.deltaY * 0.0024))
        );
        camera.zoom = nextZoom;
        const worldAfter = screenToWorld(pointerX, pointerY);
        camera.x += (worldAfter.x - worldBefore.x) * camera.zoom;
        camera.y += (worldAfter.y - worldBefore.y) * camera.zoom;
      } else {
        camera.x -= event.deltaX;
        camera.y -= event.deltaY;
      }

      scheduleRender();
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.code === "Space") {
        spacePanRef.current = true;
      }
    };

    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.code === "Space") {
        spacePanRef.current = false;
      }
    };

    const setup = async () => {
      await app.init({
        backgroundColor: themePalette[themeRef.current].sceneBackground,
        antialias: false,
        resizeTo: host,
        autoDensity: true,
        resolution: window.devicePixelRatio || 1
      });

      if (cancelled) {
        app.destroy(true, { children: true });
        return;
      }

      app.stop();
      app.canvas.style.imageRendering = "crisp-edges";
      appRef.current = app;
      worldContainerRef.current = worldContainer;
      graphicsRef.current = graphics;
      drawSceneRef.current = drawScene;
      scheduleRenderRef.current = scheduleRender;

      host.appendChild(app.canvas);
      host.style.touchAction = "none";
      const preventContextMenu = (event: Event) => event.preventDefault();
      host.addEventListener("contextmenu", preventContextMenu);
      host.addEventListener("pointerdown", handlePointerDown);
      window.addEventListener("pointermove", handlePointerMove);
      window.addEventListener("pointerup", handlePointerUp);
      host.addEventListener("wheel", handleWheel, { passive: false });
      window.addEventListener("keydown", handleKeyDown);
      window.addEventListener("keyup", handleKeyUp);
      window.addEventListener("resize", scheduleRender);

      worldContainer.addChild(graphics);
      app.stage.addChild(worldContainer);
      scheduleRender();

      return () => {
        host.removeEventListener("contextmenu", preventContextMenu);
      };
    };

    let teardownSetup: (() => void) | undefined;

    const runSetup = async () => {
      teardownSetup = await setup();
    };

    void runSetup();

    return () => {
      teardownSetup?.();
      cancelled = true;
      scheduleRenderRef.current = null;
      drawSceneRef.current = null;
      if (animationFrameRef.current !== null) {
        window.cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
      host.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      host.removeEventListener("wheel", handleWheel);
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("resize", scheduleRender);
      app.destroy(true, { children: true });
      appRef.current = null;
      worldContainerRef.current = null;
      graphicsRef.current = null;
    };
  }, []);

  return <div className="city-canvas" ref={hostRef} />;
};
