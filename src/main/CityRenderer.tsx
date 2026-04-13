import { useEffect, useRef } from "react";
import { Application, Container, Graphics } from "pixi.js";

import { CELL_SIZE, WORLD_HEIGHT, WORLD_WIDTH } from "../shared/constants";
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

type CanvasAction =
  | {
      type: "road";
      x: number;
      y: number;
      orientation: Orientation;
      mode: "add" | "remove";
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
  onAction: (action: CanvasAction) => void;
}

export type { CanvasAction };

interface CameraState {
  x: number;
  y: number;
  zoom: number;
}

const ROAD_HIT_THRESHOLD = 0.24;

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

  return 0x7d8e99;
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

export const CityRenderer = ({
  snapshot,
  overlay,
  tool,
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
  const onActionRef = useRef(onAction);
  const cameraRef = useRef<CameraState>({ x: 56, y: 56, zoom: 0.9 });
  const spacePanRef = useRef(false);

  snapshotRef.current = snapshot;
  overlayRef.current = overlay;
  toolRef.current = tool;
  onActionRef.current = onAction;

  useEffect(() => {
    scheduleRenderRef.current?.();
  }, [snapshot, overlay]);

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
      container.position.set(camera.x, camera.y);
      container.scale.set(camera.zoom);
      scene.clear();

      scene.beginFill(0x20252a);
      scene.drawRect(0, 0, CELL_SIZE * WORLD_WIDTH, CELL_SIZE * WORLD_HEIGHT);
      scene.endFill();

      scene.lineStyle(1, 0x2b3137, 1);
      for (let x = 0; x <= CELL_SIZE * WORLD_WIDTH; x += CELL_SIZE) {
        scene.moveTo(x, 0);
        scene.lineTo(x, CELL_SIZE * WORLD_HEIGHT);
      }
      for (let y = 0; y <= CELL_SIZE * WORLD_HEIGHT; y += CELL_SIZE) {
        scene.moveTo(0, y);
        scene.lineTo(CELL_SIZE * WORLD_WIDTH, y);
      }

      if (!current) {
        return;
      }

      const roadUtilization = new Map<string, number>();
      for (const edge of current.edges) {
        const fromNode = current.nodes[edge.fromNodeId];
        const toNode = current.nodes[edge.toNodeId];
        const key = `${Math.min(fromNode.x, toNode.x)},${Math.min(
          fromNode.y,
          toNode.y
        )}:${Math.max(fromNode.x, toNode.x)},${Math.max(fromNode.y, toNode.y)}`;
        roadUtilization.set(
          key,
          Math.max(edge.utilization, roadUtilization.get(key) ?? 0)
        );
      }

      for (const zone of current.zones) {
        scene.beginFill(zonePalette[zone.zoneType], 0.16);
        scene.drawRect(zone.x * CELL_SIZE, zone.y * CELL_SIZE, CELL_SIZE, CELL_SIZE);
        scene.endFill();
      }

      for (const road of current.roads) {
        const key =
          road.orientation === "horizontal"
            ? `${road.x},${road.y}:${road.x + 1},${road.y}`
            : `${road.x},${road.y}:${road.x},${road.y + 1}`;
        const utilization = roadUtilization.get(key) ?? 0;
        const roadColor =
          overlayRef.current === "traffic"
            ? overlayRoadColor(utilization)
            : 0x79838d;

        scene.lineStyle(road.lanes * 7 + 8, 0x161b1f, 1);
        if (road.orientation === "horizontal") {
          scene.moveTo(road.x * CELL_SIZE, road.y * CELL_SIZE);
          scene.lineTo((road.x + 1) * CELL_SIZE, road.y * CELL_SIZE);
        } else {
          scene.moveTo(road.x * CELL_SIZE, road.y * CELL_SIZE);
          scene.lineTo(road.x * CELL_SIZE, (road.y + 1) * CELL_SIZE);
        }

        scene.lineStyle(road.lanes * 5 + 3, roadColor, 1);
        if (road.orientation === "horizontal") {
          scene.moveTo(road.x * CELL_SIZE, road.y * CELL_SIZE);
          scene.lineTo((road.x + 1) * CELL_SIZE, road.y * CELL_SIZE);
        } else {
          scene.moveTo(road.x * CELL_SIZE, road.y * CELL_SIZE);
          scene.lineTo(road.x * CELL_SIZE, (road.y + 1) * CELL_SIZE);
        }
      }

      for (const node of current.nodes) {
        if (node.queueLength <= 0) {
          continue;
        }

        scene.beginFill(0x9d7758, 0.55);
        scene.drawCircle(
          node.x * CELL_SIZE,
          node.y * CELL_SIZE,
          Math.min(16, 5 + node.queueLength)
        );
        scene.endFill();
      }

      for (const building of current.buildings) {
        let color = 0xaeb6bc;
        if (building.kind === "powerPlant") {
          color = 0x7d93a1;
        } else if (overlayRef.current === "power") {
          color = building.powered ? 0x8b9c73 : 0xa26762;
        } else if (overlayRef.current === "happiness") {
          color = happinessColor(building.happiness);
        } else if (building.kind in zonePalette) {
          color = zonePalette[building.kind as ZoneType];
        }

        scene.beginFill(color, building.abandoned ? 0.3 : 0.82);
        scene.drawRoundedRect(
          building.cellX * CELL_SIZE + 5,
          building.cellY * CELL_SIZE + 5,
          CELL_SIZE - 10,
          CELL_SIZE - 10,
          7
        );
        scene.endFill();

        if (!building.powered && building.kind !== "powerPlant") {
          scene.lineStyle(2.5, 0x8f625d, 1);
          scene.moveTo(building.cellX * CELL_SIZE + 10, building.cellY * CELL_SIZE + 10);
          scene.lineTo(
            building.cellX * CELL_SIZE + CELL_SIZE - 10,
            building.cellY * CELL_SIZE + CELL_SIZE - 10
          );
          scene.moveTo(
            building.cellX * CELL_SIZE + CELL_SIZE - 10,
            building.cellY * CELL_SIZE + 10
          );
          scene.lineTo(
            building.cellX * CELL_SIZE + 10,
            building.cellY * CELL_SIZE + CELL_SIZE - 10
          );
        }
      }

      for (const vehicle of current.vehicles) {
        let fill = 0xcfd5db;
        if (vehicle.spriteType === "truck") {
          fill = 0xb69464;
        } else if (vehicle.spriteType === "service") {
          fill = 0x86a0b0;
        } else if (vehicle.spriteType === "van") {
          fill = 0xb3a3bc;
        }

        scene.beginFill(fill, 0.95);
        scene.drawCircle(
          vehicle.x * CELL_SIZE,
          vehicle.y * CELL_SIZE,
          vehicle.spriteType === "truck" ? 5 : 4
        );
        scene.endFill();
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
        event.button === 2 ||
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

      if (currentTool === "bulldoze") {
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
        backgroundColor: 0x20252a,
        antialias: true,
        resizeTo: host,
        autoDensity: true
      });

      if (cancelled) {
        app.destroy(true, { children: true });
        return;
      }

      app.stop();
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
