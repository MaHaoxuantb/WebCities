import type { OverlayKind, TimeScale, ToolMode, ZoneType } from "./types";

export const SIM_TICK_MS = 200;
export const SIM_PRESENTATION_INTERVAL_MS = 1000 / 30;
export const WORLD_WIDTH = 128;
export const WORLD_HEIGHT = 128;
export const CELL_SIZE = 40;

export const DEFAULT_TIME_SCALE: TimeScale = 1;
export const DEFAULT_TOOL: ToolMode = "road";
export const DEFAULT_OVERLAY: OverlayKind = "traffic";
export const DEFAULT_ZONE: ZoneType = "residential";

export const LOCAL_ROAD_SPEED = 0.8;
export const LOCAL_ROAD_LANES = 1;
export const EDGE_STORAGE_PER_LANE = 18;
export const EDGE_CAPACITY_PER_LANE = 10;

export const TRIP_GENERATION_INTERVAL = 10;
export const BUILDING_UPDATE_INTERVAL = 20;
export const OUTAGE_CHECK_INTERVAL = 25;
export const SAVE_SLOT_KEY = "autosave";

export const MAX_VISIBLE_VEHICLES = 600;
export const VEHICLE_SAMPLE_DIVISOR = 3;
