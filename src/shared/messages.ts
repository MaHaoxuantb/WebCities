import type {
  Building,
  NotificationMessage,
  OverlayKind,
  ReplayCommand,
  ServiceKind,
  SimSnapshot,
  TimeScale,
  ZoneType
} from "./types";
import type { SaveGameV1 } from "./save";

export interface WorkerEnvelope<TType extends string, TPayload = undefined> {
  version: 1;
  type: TType;
  payload: TPayload;
}

export type MainToWorkerMessage =
  | WorkerEnvelope<"initWorld", { width: number; height: number; seed: number }>
  | WorkerEnvelope<
      "editRoad",
      {
        x: number;
        y: number;
        orientation: "horizontal" | "vertical";
        mode: "add" | "remove";
      }
    >
  | WorkerEnvelope<
      "editZone",
      { x: number; y: number; zoneType: ZoneType | null }
    >
  | WorkerEnvelope<
      "bulldozeAt",
      {
        cellX: number;
        cellY: number;
        road?:
          | {
              x: number;
              y: number;
              orientation: "horizontal" | "vertical";
            }
          | null;
      }
    >
  | WorkerEnvelope<
      "placeLargeJunction",
      {
        centerCellX: number;
        centerCellY: number;
      }
    >
  | WorkerEnvelope<
      "placeBuilding",
      {
        x: number;
        y: number;
        building: Pick<Building, "kind" | "occupancy" | "jobs">;
      }
    >
  | WorkerEnvelope<
      "placeService",
      { x: number; y: number; kind: ServiceKind }
    >
  | WorkerEnvelope<"setBudget", { delta: number }>
  | WorkerEnvelope<"setTimeScale", { timeScale: TimeScale }>
  | WorkerEnvelope<"requestOverlay", { overlay: OverlayKind }>
  | WorkerEnvelope<"saveGame", { slotKey: string }>
  | WorkerEnvelope<"loadGame", { saveGame: SaveGameV1 }>
  | WorkerEnvelope<"requestSnapshot", undefined>;

export type WorkerToMainMessage =
  | WorkerEnvelope<"simSnapshot", { snapshot: SimSnapshot }>
  | WorkerEnvelope<"overlayData", { overlay: OverlayKind; snapshot: SimSnapshot }>
  | WorkerEnvelope<"cityStats", SimSnapshot["cityStats"]>
  | WorkerEnvelope<"perfStats", SimSnapshot["perfStats"]>
  | WorkerEnvelope<"notification", NotificationMessage>
  | WorkerEnvelope<"saveReady", { slotKey: string; saveGame: SaveGameV1 }>
  | WorkerEnvelope<"replayLog", { commands: ReplayCommand[] }>;

export const toWorkerMessage = <TType extends MainToWorkerMessage["type"]>(
  type: TType,
  payload: Extract<MainToWorkerMessage, { type: TType }>["payload"]
): Extract<MainToWorkerMessage, { type: TType }> =>
  ({
    version: 1,
    type,
    payload
  }) as Extract<MainToWorkerMessage, { type: TType }>;

export const toMainMessage = <TType extends WorkerToMainMessage["type"]>(
  type: TType,
  payload: Extract<WorkerToMainMessage, { type: TType }>["payload"]
): Extract<WorkerToMainMessage, { type: TType }> =>
  ({
    version: 1,
    type,
    payload
  }) as Extract<WorkerToMainMessage, { type: TType }>;
