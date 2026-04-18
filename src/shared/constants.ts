import type {
  CityStage,
  MilestoneDefinition,
  OverlayKind,
  TimeScale,
  ToolMode,
  UnlockState,
  ZoneType
} from "./types";

export const SIM_TICK_MS = 200;
export const SIM_PRESENTATION_INTERVAL_MS = 1000 / 30;
export const WORLD_WIDTH = 128;
export const WORLD_HEIGHT = 128;
export const CELL_SIZE = 40;

export const DEFAULT_TIME_SCALE: TimeScale = 1;
export const DEFAULT_TOOL: ToolMode = "road";
export const DEFAULT_OVERLAY: OverlayKind = "none";
export const DEFAULT_ZONE: ZoneType = "residential";

export const LOCAL_ROAD_SPEED = 0.8;
export const LOCAL_ROAD_LANES = 1;
export const EDGE_STORAGE_PER_LANE = 18;
export const EDGE_CAPACITY_PER_LANE = 10;
export const ARTERIAL_ROAD_SPEED = 1.2;
export const ARTERIAL_ROAD_LANES = 2;

export const TRIP_GENERATION_INTERVAL = 10;
export const BUILDING_UPDATE_INTERVAL = 20;
export const OUTAGE_CHECK_INTERVAL = 25;
export const SAVE_SLOT_KEY = "autosave";

export const MAX_VISIBLE_VEHICLES = 600;
export const VEHICLE_SAMPLE_DIVISOR = 3;

export const BASE_ROAD_BUILD_COST = 16;
export const BASE_ZONE_COST: Record<ZoneType, number> = {
  residential: 24,
  commercial: 30,
  industrial: 34
};
export const BASE_POWER_PLANT_COST = 520;

export const INITIAL_UNLOCKS: UnlockState = {
  arterialRoads: false,
  denserZones: false,
  advancedPowerPlants: false,
  occupancyCapBonus: 0
};

export const CITY_STAGE_ORDER: CityStage[] = [
  "bootstrap",
  "town",
  "logistics",
  "resilience"
];

export const MILESTONE_DEFINITIONS: MilestoneDefinition[] = [
  {
    id: "bootstrap-power",
    stage: "bootstrap",
    title: "Bootstrap The Grid",
    summary: "Create the first stable powered neighborhood and stop the city from bleeding cash.",
    primaryLabel: "Powered homes",
    primaryMetric: "population",
    primaryTarget: 18,
    primaryComparator: "gte",
    secondary: [
      {
        label: "Positive budget flow",
        metric: "budgetDelta",
        target: 0,
        comparator: "gte"
      },
      {
        label: "Grid outage pressure",
        metric: "outages",
        target: 1,
        comparator: "lte"
      }
    ],
    rewardText: "Growth charter approved: denser zoning standards and a 600 credit subsidy."
  },
  {
    id: "town-growth",
    stage: "town",
    title: "Raise A Working Town",
    summary: "Grow jobs and residents together without letting reliability collapse.",
    primaryLabel: "Population",
    primaryMetric: "population",
    primaryTarget: 110,
    primaryComparator: "gte",
    secondary: [
      {
        label: "Productive jobs",
        metric: "productiveJobs",
        target: 70,
        comparator: "gte"
      },
      {
        label: "Service reliability",
        metric: "avgServiceReliability",
        target: 0.72,
        comparator: "gte"
      }
    ],
    rewardText: "Mobility bonds issued: arterial roads unlocked and 900 credits awarded."
  },
  {
    id: "logistics-flow",
    stage: "logistics",
    title: "Stabilize Freight Flow",
    summary: "Keep the city moving as industry and retail begin to load the same network.",
    primaryLabel: "Trip completion",
    primaryMetric: "tripCompletionRate",
    primaryTarget: 0.72,
    primaryComparator: "gte",
    secondary: [
      {
        label: "Congestion stress",
        metric: "congestionStress",
        target: 0.46,
        comparator: "lte"
      },
      {
        label: "Productive jobs",
        metric: "productiveJobs",
        target: 120,
        comparator: "gte"
      }
    ],
    rewardText: "Regional utility grant: advanced power plants unlocked and 1200 credits awarded."
  },
  {
    id: "resilience-run",
    stage: "resilience",
    title: "Hold A Resilient City",
    summary: "Sustain a large city through pressure spikes without debt or systemic breakdowns.",
    primaryLabel: "Population",
    primaryMetric: "population",
    primaryTarget: 190,
    primaryComparator: "gte",
    secondary: [
      {
        label: "Debt pressure",
        metric: "debtPressure",
        target: 28,
        comparator: "lte"
      },
      {
        label: "Trip completion",
        metric: "tripCompletionRate",
        target: 0.78,
        comparator: "gte"
      }
    ],
    rewardText: "Resilience charter complete: occupancy cap raised and the city earns prestige score bonuses."
  }
];
