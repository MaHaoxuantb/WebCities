export type Orientation = "horizontal" | "vertical";
export type ZoneType = "residential" | "commercial" | "industrial";
export type ServiceKind = "power";
export type TripPurpose = "commute" | "commercial" | "cargo" | "service";
export type OverlayKind = "traffic" | "power" | "happiness";
export type TimeScale = 0 | 1 | 2 | 3;
export type ToolMode =
  | "road"
  | "bulldoze"
  | "zone-residential"
  | "zone-commercial"
  | "zone-industrial"
  | "service-power";

export interface RoadSegment {
  key: string;
  x: number;
  y: number;
  orientation: Orientation;
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
  activeTrips: number;
  queuedTrips: number;
  avgTravelTime: number;
  budget: number;
  demandResidential: number;
  demandCommercial: number;
  demandIndustrial: number;
  outages: number;
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
}

export interface ReplayCommand {
  tick: number;
  command:
    | "editRoad"
    | "editZone"
    | "placeBuilding"
    | "placeService"
    | "setBudget"
    | "setTimeScale";
  payload: unknown;
}
