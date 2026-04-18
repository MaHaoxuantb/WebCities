export type Orientation = "horizontal" | "vertical";
export type RoadDirection = "both" | "forward" | "reverse";
export type ZoneType = "residential" | "commercial" | "industrial";
export type ServiceKind = "power";
export type TripPurpose = "commute" | "commercial" | "cargo" | "service";
export type OverlayKind = "none" | "traffic" | "power" | "happiness";
export type TimeScale = 0 | 1 | 2 | 3;
export type CityStage = "bootstrap" | "town" | "logistics" | "resilience";
export type MilestoneId =
  | "bootstrap-power"
  | "town-growth"
  | "logistics-flow"
  | "resilience-run";
export type ToolMode =
  | "road"
  | "zone-residential"
  | "zone-commercial"
  | "zone-industrial"
  | "service-power";

export interface RoadSegment {
  key: string;
  x: number;
  y: number;
  orientation: Orientation;
  direction: RoadDirection;
  lanes: number;
  speedLimit: number;
}

export interface RoadNode {
  id: number;
  x: number;
  y: number;
  queueLength: number;
}

export interface RoadEdge {
  id: number;
  fromNodeId: number;
  toNodeId: number;
  length: number;
  speedLimit: number;
  lanes: number;
  capacity: number;
  storage: number;
  load: number;
  utilization: number;
  travelTime: number;
  blocked: boolean;
  baseTravelTime: number;
}

export interface ZoneCell {
  cellKey: string;
  x: number;
  y: number;
  zoneType: ZoneType;
}

export interface Building {
  id: number;
  cellX: number;
  cellY: number;
  kind: ZoneType | "powerPlant";
  occupancy: number;
  jobs: number;
  powered: boolean;
  happiness: number;
  abandoned: boolean;
  accessNodeIds: number[];
  outageTicksRemaining: number;
  serviceReliability: number;
  throughputScore: number;
  productivity: number;
  recentOutageTicks: number;
}

export interface ServiceFacility {
  id: number;
  buildingId: number;
  kind: ServiceKind;
  crewCapacity: number;
  activeJobIds: number[];
}

export interface TripRequest {
  originBuildingId: number;
  destinationBuildingId: number;
  purpose: TripPurpose;
  departureTick: number;
  quantity: number;
}

export interface Route {
  originNodeId: number;
  destinationNodeId: number;
  edgeIds: number[];
  cost: number;
}

export interface TripPacket {
  id: number;
  purpose: TripPurpose;
  quantity: number;
  routeEdgeIds: number[];
  currentLeg: number;
  currentNodeId: number;
  currentEdgeId: number | null;
  edgeTicksRemaining: number;
  edgeTicksTotal: number;
  originBuildingId: number;
  destinationBuildingId: number;
  state: "queued" | "moving" | "complete" | "failed";
  colorHint: number;
  serviceJobId?: number;
}

export interface PowerJob {
  id: number;
  buildingId: number;
  assignedPacketId: number | null;
  createdTick: number;
  state: "pending" | "assigned" | "resolved";
}

export interface VisibleVehicle {
  id: number;
  packetId: number;
  x: number;
  y: number;
  heading: number;
  spriteType: "car" | "van" | "truck" | "service";
  weight: number;
}

export interface CityStats {
  tick: number;
  population: number;
  jobs: number;
  productiveJobs: number;
  activeTrips: number;
  queuedTrips: number;
  avgTravelTime: number;
  tripCompletionRate: number;
  avgServiceReliability: number;
  congestionStress: number;
  budget: number;
  budgetIncome: number;
  roadsUpkeep: number;
  facilitiesUpkeep: number;
  budgetDelta: number;
  positiveBudgetStreak: number;
  debtPressure: number;
  demandResidential: number;
  demandCommercial: number;
  demandIndustrial: number;
  outages: number;
  poweredBuildings: number;
  totalBuildings: number;
  powerPlants: number;
}

export interface UnlockState {
  arterialRoads: boolean;
  denserZones: boolean;
  advancedPowerPlants: boolean;
  occupancyCapBonus: number;
}

export interface MilestoneConstraintProgress {
  label: string;
  current: number;
  target: number;
  comparator: "gte" | "lte";
  complete: boolean;
}

export interface MilestoneDefinition {
  id: MilestoneId;
  stage: CityStage;
  title: string;
  summary: string;
  primaryLabel: string;
  primaryMetric: keyof CityStats;
  primaryTarget: number;
  primaryComparator: "gte" | "lte";
  secondary: Array<{
    label: string;
    metric: keyof CityStats;
    target: number;
    comparator: "gte" | "lte";
  }>;
  rewardText: string;
}

export interface MilestoneProgress {
  id: MilestoneId;
  stage: CityStage;
  title: string;
  summary: string;
  rewardText: string;
  primary: MilestoneConstraintProgress;
  secondary: MilestoneConstraintProgress[];
  blockers: string[];
  complete: boolean;
}

export interface ProgressionState {
  currentStage: CityStage;
  threatLevel: number;
  pressureTier: number;
  activeMilestoneId: MilestoneId | null;
  completedMilestoneIds: MilestoneId[];
  rewardLog: string[];
  unlocks: UnlockState;
  activeMilestone: MilestoneProgress | null;
  score: number;
  cityGrade: string;
}

export interface PerfStats {
  tickMs: number;
  routeCacheSize: number;
  snapshotBytesEstimate: number;
}

export interface NotificationMessage {
  id: number;
  text: string;
  level: "info" | "warning" | "error";
}

export interface SimSnapshot {
  tick: number;
  timeScale: TimeScale;
  simulationAlpha: number;
  roads: RoadSegment[];
  nodes: RoadNode[];
  edges: RoadEdge[];
  zones: ZoneCell[];
  buildings: Building[];
  services: ServiceFacility[];
  vehicles: VisibleVehicle[];
  cityStats: CityStats;
  perfStats: PerfStats;
  overlay: OverlayKind;
  progression: ProgressionState;
}

export interface ReplayCommand {
  tick: number;
  command:
    | "editRoad"
    | "editZone"
    | "bulldozeAt"
    | "placeBuilding"
    | "placeService"
    | "setBudget"
    | "setTimeScale";
  payload?: unknown;
}
