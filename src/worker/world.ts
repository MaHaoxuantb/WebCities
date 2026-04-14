import {
  BUILDING_UPDATE_INTERVAL,
  EDGE_CAPACITY_PER_LANE,
  EDGE_STORAGE_PER_LANE,
  LOCAL_ROAD_LANES,
  LOCAL_ROAD_SPEED,
  MAX_VISIBLE_VEHICLES,
  OUTAGE_CHECK_INTERVAL,
  SIM_TICK_MS,
  TRIP_GENERATION_INTERVAL,
  VEHICLE_SAMPLE_DIVISOR
} from "../shared/constants";
import { parseSaveGame, type SaveGameV1 } from "../shared/save";
import { createRng, type SeededRng } from "../shared/rng";
import type {
  Building,
  CityStats,
  NotificationMessage,
  OverlayKind,
  Orientation,
  PerfStats,
  PowerJob,
  ReplayCommand,
  RoadEdge,
  RoadNode,
  RoadSegment,
  Route,
  ServiceFacility,
  ServiceKind,
  SimSnapshot,
  TimeScale,
  TripPacket,
  TripPurpose,
  VisibleVehicle,
  ZoneCell,
  ZoneType
} from "../shared/types";
import { findBestRoute } from "./pathfinding";

interface WorldIds {
  buildingId: number;
  facilityId: number;
  tripId: number;
  powerJobId: number;
  notificationId: number;
}

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

const roadKey = (x: number, y: number, orientation: Orientation) =>
  `${orientation}:${x},${y}`;

const cellKey = (x: number, y: number) => `${x},${y}`;
const nodeCoordKey = (x: number, y: number) => `${x},${y}`;

const defaultIds = (): WorldIds => ({
  buildingId: 1,
  facilityId: 1,
  tripId: 1,
  powerJobId: 1,
  notificationId: 1
});

const baseJobsForZone = (zoneType: ZoneType) => {
  if (zoneType === "commercial") {
    return 8;
  }

  if (zoneType === "industrial") {
    return 14;
  }

  return 0;
};

const spriteTypeForPurpose = (
  purpose: TripPurpose
): VisibleVehicle["spriteType"] => {
  if (purpose === "service") {
    return "service";
  }

  if (purpose === "cargo") {
    return "truck";
  }

  if (purpose === "commercial") {
    return "van";
  }

  return "car";
};

const JUNCTION_LANES = LOCAL_ROAD_LANES;
const JUNCTION_SPEED = 1.05;

export class SimWorld {
  width: number;
  height: number;
  seed: number;
  tick = 0;
  budget = 2500;
  timeScale: TimeScale = 1;
  overlay: OverlayKind = "traffic";
  networkVersion = 0;
  lastTickMs = 0;

  readonly routeCache = new Map<string, Route | null>();
  readonly replayLog: ReplayCommand[] = [];

  private ids: WorldIds = defaultIds();
  private readonly roads = new Map<string, RoadSegment>();
  private readonly zones = new Map<string, ZoneCell>();
  private readonly buildings = new Map<number, Building>();
  private readonly buildingByCell = new Map<string, number>();
  private readonly facilities = new Map<number, ServiceFacility>();
  private readonly powerJobs = new Map<number, PowerJob>();
  private readonly activeTrips = new Map<number, TripPacket>();
  private readonly pendingNotifications: NotificationMessage[] = [];

  private rng: SeededRng;
  private readonly nodeIdByCoord = new Map<string, number>();

  nodes: RoadNode[] = [];
  edges: RoadEdge[] = [];
  adjacency: number[][] = [];

  constructor(width: number, height: number, seed: number) {
    this.width = width;
    this.height = height;
    this.seed = seed;
    this.rng = createRng(seed);
  }

  static fromSave(input: unknown) {
    const save = parseSaveGame(input);
    const world = new SimWorld(save.width, save.height, save.seed);

    world.tick = save.tick;
    world.budget = save.budget;
    world.timeScale = save.timeScale;
    world.overlay = save.overlay;
    world.ids = save.nextIds;
    world.rng = createRng(save.seed + save.tick);

    for (const road of save.roads) {
      world.roads.set(road.key, road);
    }

    for (const zone of save.zones) {
      world.zones.set(zone.cellKey, zone);
    }

    for (const building of save.buildings) {
      world.buildings.set(building.id, building);
      world.buildingByCell.set(cellKey(building.cellX, building.cellY), building.id);
    }

    for (const facility of save.serviceFacilities) {
      world.facilities.set(facility.id, facility);
    }

    for (const trip of save.activeTrips) {
      world.activeTrips.set(trip.id, trip);
    }

    for (const job of save.powerJobs) {
      world.powerJobs.set(job.id, job);
    }

    world.replayLog.push(...save.replayLog);
    world.rebuildGraph();
    return world;
  }

  serialize(): SaveGameV1 {
    return {
      version: 1,
      width: this.width,
      height: this.height,
      tick: this.tick,
      seed: this.seed,
      budget: this.budget,
      timeScale: this.timeScale,
      overlay: this.overlay,
      nextIds: this.ids,
      roads: this.getRoads(),
      zones: this.getZones(),
      buildings: this.getBuildings(),
      serviceFacilities: this.getFacilities(),
      activeTrips: this.getActiveTrips(),
      powerJobs: this.getPowerJobs(),
      replayLog: [...this.replayLog]
    };
  }

  consumeNotifications() {
    const notifications = [...this.pendingNotifications];
    this.pendingNotifications.length = 0;
    return notifications;
  }

  getSnapshot(): SimSnapshot {
    const snapshot: SimSnapshot = {
      tick: this.tick,
      timeScale: this.timeScale,
      roads: this.getRoads(),
      nodes: this.nodes.map((node) => ({ ...node })),
      edges: this.edges.map((edge) => ({ ...edge })),
      zones: this.getZones(),
      buildings: this.getBuildings(),
      services: this.getFacilities(),
      vehicles: this.sampleVisibleVehicles(),
      cityStats: this.computeStats(),
      perfStats: this.computePerfStats(),
      overlay: this.overlay
    };

    return snapshot;
  }

  setOverlay(overlay: OverlayKind) {
    this.overlay = overlay;
  }

  setBudget(delta: number) {
    this.budget += delta;
    this.recordReplay("setBudget", { delta });
  }

  setTimeScale(timeScale: TimeScale) {
    this.timeScale = timeScale;
    this.recordReplay("setTimeScale", { timeScale });
  }

  placeLargeJunction(centerCellX: number, centerCellY: number) {
    if (
      centerCellX <= 0 ||
      centerCellY <= 0 ||
      centerCellX >= this.width ||
      centerCellY >= this.height
    ) {
      this.pushNotification(
        "Roundabout must sit on an interior intersection so it can use the four adjacent cells.",
        "warning"
      );
      return;
    }

    const left = centerCellX - 1;
    const top = centerCellY - 1;

    if (!this.isAreaClear(left, top, 2)) {
      this.pushNotification(
        "Clear the four adjacent cells before placing a roundabout.",
        "warning"
      );
      return;
    }

    this.roads.delete(roadKey(centerCellX - 1, centerCellY, "horizontal"));
    this.roads.delete(roadKey(centerCellX, centerCellY, "horizontal"));
    this.roads.delete(roadKey(centerCellX, centerCellY - 1, "vertical"));
    this.roads.delete(roadKey(centerCellX, centerCellY, "vertical"));

    this.upsertRoadSegment(left, top, "horizontal", JUNCTION_LANES, JUNCTION_SPEED);
    this.upsertRoadSegment(centerCellX, top, "horizontal", JUNCTION_LANES, JUNCTION_SPEED);
    this.upsertRoadSegment(
      left,
      centerCellY + 1,
      "horizontal",
      JUNCTION_LANES,
      JUNCTION_SPEED
    );
    this.upsertRoadSegment(
      centerCellX,
      centerCellY + 1,
      "horizontal",
      JUNCTION_LANES,
      JUNCTION_SPEED
    );
    this.upsertRoadSegment(left, top, "vertical", JUNCTION_LANES, JUNCTION_SPEED);
    this.upsertRoadSegment(left, centerCellY, "vertical", JUNCTION_LANES, JUNCTION_SPEED);
    this.upsertRoadSegment(
      centerCellX + 1,
      top,
      "vertical",
      JUNCTION_LANES,
      JUNCTION_SPEED
    );
    this.upsertRoadSegment(
      centerCellX + 1,
      centerCellY,
      "vertical",
      JUNCTION_LANES,
      JUNCTION_SPEED
    );

    this.recordReplay("placeLargeJunction", { centerCellX, centerCellY });
    this.rebuildGraph();
    this.pushNotification(
      `Roundabout placed around intersection (${centerCellX}, ${centerCellY}).`,
      "info"
    );
  }

  bulldozeAt(
    cellX: number,
    cellY: number,
    road?:
      | {
          x: number;
          y: number;
          orientation: Orientation;
        }
      | null
  ) {
    let didChange = false;

    if (road) {
      const key = roadKey(road.x, road.y, road.orientation);
      if (this.roads.has(key)) {
        this.roads.delete(key);
        didChange = true;
        this.rebuildGraph();
      }
    }

    if (!didChange && this.isValidCell(cellX, cellY)) {
      didChange = this.removeCellContents(cellX, cellY);
    }

    if (didChange) {
      this.recordReplay("bulldozeAt", { cellX, cellY, road });
      this.refreshBuildingAccess();
    }
  }

  editRoad(
    x: number,
    y: number,
    orientation: Orientation,
    mode: "add" | "remove"
  ) {
    if (!this.isValidRoadCoordinate(x, y, orientation)) {
      return;
    }

    const key = roadKey(x, y, orientation);

    if (mode === "add") {
      this.upsertRoadSegment(x, y, orientation, LOCAL_ROAD_LANES, LOCAL_ROAD_SPEED);
    } else {
      this.roads.delete(key);
    }

    this.recordReplay("editRoad", { x, y, orientation, mode });
    this.rebuildGraph();
  }

  editZone(x: number, y: number, zoneType: ZoneType | null) {
    if (!this.isValidCell(x, y)) {
      return;
    }

    const key = cellKey(x, y);
    if (zoneType === null) {
      this.zones.delete(key);
      const existingBuildingId = this.buildingByCell.get(key);
      if (existingBuildingId) {
        const building = this.buildings.get(existingBuildingId);
        if (building && building.kind !== "powerPlant") {
          this.buildings.delete(existingBuildingId);
          this.buildingByCell.delete(key);
        }
      }
    } else {
      const zoneCell: ZoneCell = { cellKey: key, x, y, zoneType };
      this.zones.set(key, zoneCell);
      this.upsertZonedBuilding(zoneCell);
    }

    this.recordReplay("editZone", { x, y, zoneType });
    this.refreshBuildingAccess();
  }

  placeBuilding(
    x: number,
    y: number,
    buildingInput: Pick<Building, "kind" | "occupancy" | "jobs">
  ) {
    if (!this.isValidCell(x, y)) {
      return;
    }

    const id = this.ids.buildingId++;
    const building: Building = {
      id,
      cellX: x,
      cellY: y,
      kind: buildingInput.kind,
      occupancy: buildingInput.occupancy,
      jobs: buildingInput.jobs,
      powered: true,
      happiness: 0.8,
      abandoned: false,
      accessNodeIds: [],
      outageTicksRemaining: 0
    };

    this.buildings.set(id, building);
    this.buildingByCell.set(cellKey(x, y), id);
    this.refreshBuildingAccess();
    this.recordReplay("placeBuilding", { x, y, building: buildingInput });
  }

  placeService(x: number, y: number, kind: ServiceKind) {
    if (!this.isValidCell(x, y) || kind !== "power") {
      return;
    }

    const slotKey = cellKey(x, y);
    const existingBuildingId = this.buildingByCell.get(slotKey);
    if (existingBuildingId) {
      const existingBuilding = this.buildings.get(existingBuildingId);
      if (existingBuilding?.kind === "powerPlant") {
        return;
      }
      this.removeBuilding(existingBuildingId);
    }

    this.zones.delete(slotKey);

    const buildingId = this.ids.buildingId++;
    const building: Building = {
      id: buildingId,
      cellX: x,
      cellY: y,
      kind: "powerPlant",
      occupancy: 0,
      jobs: 20,
      powered: true,
      happiness: 1,
      abandoned: false,
      accessNodeIds: [],
      outageTicksRemaining: 0
    };
    this.buildings.set(buildingId, building);
    this.buildingByCell.set(slotKey, buildingId);

    const facilityId = this.ids.facilityId++;
    this.facilities.set(facilityId, {
      id: facilityId,
      buildingId,
      kind,
      crewCapacity: 2,
      activeJobIds: []
    });

    this.pushNotification(`Power facility placed at (${x}, ${y}).`, "info");
    this.refreshBuildingAccess();
    this.recordReplay("placeService", { x, y, kind });
  }

  tickOnce() {
    const startedAt = performance.now();
    this.tick += 1;

    this.moveTrips();
    this.updateEdgeDynamics();

    if (this.tick % TRIP_GENERATION_INTERVAL === 0) {
      this.generateDemandTrips();
      this.dispatchPowerCrews();
    }

    if (this.tick % OUTAGE_CHECK_INTERVAL === 0) {
      this.generateOutages();
    }

    if (this.tick % BUILDING_UPDATE_INTERVAL === 0) {
      this.updateBuildingsAndEconomy();
    }

    this.lastTickMs = performance.now() - startedAt;
  }

  debugRouteBetweenBuildings(originBuildingId: number, destinationBuildingId: number) {
    const originBuilding = this.buildings.get(originBuildingId);
    const destinationBuilding = this.buildings.get(destinationBuildingId);
    if (!originBuilding || !destinationBuilding) {
      return null;
    }

    return findBestRoute(
      {
        nodes: this.nodes,
        edges: this.edges,
        adjacency: this.adjacency,
        networkVersion: this.networkVersion
      },
      originBuilding.accessNodeIds,
      destinationBuilding.accessNodeIds,
      this.routeCache
    );
  }

  debugCreateTrip(
    originBuildingId: number,
    destinationBuildingId: number,
    purpose: TripPurpose = "commute",
    quantity = 1
  ) {
    return this.createTripPacket(
      originBuildingId,
      destinationBuildingId,
      purpose,
      quantity
    );
  }

  debugState() {
    return {
      activeTrips: this.getActiveTrips(),
      buildings: this.getBuildings(),
      powerJobs: this.getPowerJobs()
    };
  }

  private getRoads() {
    return [...this.roads.values()];
  }

  private getZones() {
    return [...this.zones.values()];
  }

  private getBuildings() {
    return [...this.buildings.values()];
  }

  private getFacilities() {
    return [...this.facilities.values()];
  }

  private getActiveTrips() {
    return [...this.activeTrips.values()];
  }

  private getPowerJobs() {
    return [...this.powerJobs.values()];
  }

  private computeStats(): CityStats {
    const buildings = this.getBuildings();
    const population = buildings
      .filter((building) => building.kind === "residential")
      .reduce((sum, building) => sum + building.occupancy, 0);
    const jobs = buildings.reduce((sum, building) => sum + building.jobs, 0);
    const queuedTrips = this.getActiveTrips().filter((trip) => trip.state === "queued")
      .length;
    const activeEdges = this.edges.filter((edge) => edge.load > 0);
    const avgTravelTime =
      activeEdges.length > 0
        ? activeEdges.reduce((sum, edge) => sum + edge.travelTime, 0) /
          activeEdges.length
        : 0;

    const residentialCount = buildings.filter(
      (building) => building.kind === "residential" && !building.abandoned
    ).length;
    const commercialCount = buildings.filter(
      (building) => building.kind === "commercial" && !building.abandoned
    ).length;
    const industrialCount = buildings.filter(
      (building) => building.kind === "industrial" && !building.abandoned
    ).length;
    const totalBuildings = buildings.filter((building) => building.kind !== "powerPlant").length;
    const poweredBuildings = buildings.filter(
      (building) => building.kind !== "powerPlant" && building.powered
    ).length;
    const powerPlants = buildings.filter((building) => building.kind === "powerPlant").length;

    return {
      tick: this.tick,
      population,
      jobs,
      activeTrips: this.activeTrips.size,
      queuedTrips,
      avgTravelTime,
      budget: this.budget,
      demandResidential: clamp((jobs - population) * 2 + 50, 0, 100),
      demandCommercial: clamp(
        population > 0 ? (commercialCount / Math.max(1, residentialCount)) * 40 : 35,
        0,
        100
      ),
      demandIndustrial: clamp(
        population > 0 ? (industrialCount / Math.max(1, population / 12)) * 50 : 30,
        0,
        100
      ),
      outages: [...this.powerJobs.values()].filter((job) => job.state !== "resolved")
        .length,
      poweredBuildings,
      totalBuildings,
      powerPlants
    };
  }

  private computePerfStats(): PerfStats {
    return {
      tickMs: Number(this.lastTickMs.toFixed(2)),
      routeCacheSize: this.routeCache.size,
      snapshotBytesEstimate:
        this.roads.size * 48 +
        this.edges.length * 72 +
        this.buildings.size * 64 +
        this.activeTrips.size * 96
    };
  }

  private pushNotification(text: string, level: NotificationMessage["level"]) {
    const notification: NotificationMessage = {
      id: this.ids.notificationId++,
      text,
      level
    };
    this.pendingNotifications.push(notification);
  }

  private recordReplay(command: ReplayCommand["command"], payload: unknown) {
    this.replayLog.push({
      tick: this.tick,
      command,
      payload
    });
  }

  private isValidCell(x: number, y: number) {
    return x >= 0 && x < this.width && y >= 0 && y < this.height;
  }

  private isValidRoadCoordinate(
    x: number,
    y: number,
    orientation: Orientation
  ) {
    if (orientation === "horizontal") {
      return x >= 0 && x < this.width && y >= 0 && y <= this.height;
    }

    return x >= 0 && x <= this.width && y >= 0 && y < this.height;
  }

  private upsertZonedBuilding(zoneCell: ZoneCell) {
    const existingBuildingId = this.buildingByCell.get(zoneCell.cellKey);
    if (existingBuildingId) {
      const existingBuilding = this.buildings.get(existingBuildingId);
      if (existingBuilding && existingBuilding.kind !== "powerPlant") {
        existingBuilding.kind = zoneCell.zoneType;
        existingBuilding.jobs = baseJobsForZone(zoneCell.zoneType);
        if (zoneCell.zoneType !== "residential") {
          existingBuilding.occupancy = Math.max(existingBuilding.occupancy, 0);
        }
        return;
      }
    }

    const buildingId = this.ids.buildingId++;
    this.buildings.set(buildingId, {
      id: buildingId,
      cellX: zoneCell.x,
      cellY: zoneCell.y,
      kind: zoneCell.zoneType,
      occupancy: zoneCell.zoneType === "residential" ? 4 : 0,
      jobs: baseJobsForZone(zoneCell.zoneType),
      powered: true,
      happiness: 0.7,
      abandoned: false,
      accessNodeIds: this.resolveBuildingAccess(zoneCell.x, zoneCell.y),
      outageTicksRemaining: 0
    });
    this.buildingByCell.set(zoneCell.cellKey, buildingId);
  }

  private resolveBuildingAccess(x: number, y: number) {
    const candidates = new Set<number>();
    const top = this.roads.get(roadKey(x, y, "horizontal"));
    const bottom = this.roads.get(roadKey(x, y + 1, "horizontal"));
    const left = this.roads.get(roadKey(x, y, "vertical"));
    const right = this.roads.get(roadKey(x + 1, y, "vertical"));

    const collectNodes = (segment: RoadSegment | undefined) => {
      if (!segment) {
        return;
      }

      if (segment.orientation === "horizontal") {
        const a = this.nodeIdByCoord.get(nodeCoordKey(segment.x, segment.y));
        const b = this.nodeIdByCoord.get(nodeCoordKey(segment.x + 1, segment.y));
        if (a !== undefined) {
          candidates.add(a);
        }
        if (b !== undefined) {
          candidates.add(b);
        }
      } else {
        const a = this.nodeIdByCoord.get(nodeCoordKey(segment.x, segment.y));
        const b = this.nodeIdByCoord.get(nodeCoordKey(segment.x, segment.y + 1));
        if (a !== undefined) {
          candidates.add(a);
        }
        if (b !== undefined) {
          candidates.add(b);
        }
      }
    };

    collectNodes(top);
    collectNodes(bottom);
    collectNodes(left);
    collectNodes(right);

    return [...candidates];
  }

  private refreshBuildingAccess() {
    for (const building of this.buildings.values()) {
      building.accessNodeIds = this.resolveBuildingAccess(building.cellX, building.cellY);
    }
    this.refreshPowerState();
  }

  private refreshPowerState() {
    const energizedNodes = new Set<number>();
    const queue: number[] = [];

    for (const facility of this.facilities.values()) {
      const sourceBuilding = this.buildings.get(facility.buildingId);
      if (!sourceBuilding || sourceBuilding.accessNodeIds.length === 0) {
        continue;
      }

      for (const nodeId of sourceBuilding.accessNodeIds) {
        if (energizedNodes.has(nodeId)) {
          continue;
        }

        energizedNodes.add(nodeId);
        queue.push(nodeId);
      }
    }

    while (queue.length > 0) {
      const nodeId = queue.shift()!;
      for (const edgeId of this.adjacency[nodeId] ?? []) {
        const edge = this.edges[edgeId];
        if (!energizedNodes.has(edge.toNodeId)) {
          energizedNodes.add(edge.toNodeId);
          queue.push(edge.toNodeId);
        }
      }
    }

    for (const building of this.buildings.values()) {
      if (building.kind === "powerPlant") {
        building.powered = true;
        continue;
      }

      const connected =
        building.accessNodeIds.length > 0 &&
        building.accessNodeIds.some((nodeId) => energizedNodes.has(nodeId));
      building.powered = connected && building.outageTicksRemaining <= 0;
    }
  }

  private isAreaClear(left: number, top: number, size: number) {
    for (let x = left; x < left + size; x += 1) {
      for (let y = top; y < top + size; y += 1) {
        const slotKey = cellKey(x, y);
        if (this.zones.has(slotKey) || this.buildingByCell.has(slotKey)) {
          return false;
        }
      }
    }

    return true;
  }

  private upsertRoadSegment(
    x: number,
    y: number,
    orientation: Orientation,
    lanes: number,
    speedLimit: number
  ) {
    const key = roadKey(x, y, orientation);
    this.roads.set(key, {
      key,
      x,
      y,
      orientation,
      lanes,
      speedLimit
    });
  }

  private removeCellContents(cellX: number, cellY: number) {
    const slotKey = cellKey(cellX, cellY);
    let changed = false;

    const buildingId = this.buildingByCell.get(slotKey);
    if (buildingId !== undefined) {
      this.removeBuilding(buildingId);
      changed = true;
    }

    if (this.zones.delete(slotKey)) {
      changed = true;
    }

    return changed;
  }

  private removeBuilding(buildingId: number) {
    const building = this.buildings.get(buildingId);
    if (!building) {
      return;
    }

    this.buildings.delete(buildingId);
    this.buildingByCell.delete(cellKey(building.cellX, building.cellY));

    for (const [facilityId, facility] of this.facilities.entries()) {
      if (facility.buildingId === buildingId) {
        this.facilities.delete(facilityId);
      }
    }

    for (const [jobId, job] of this.powerJobs.entries()) {
      if (job.buildingId === buildingId) {
        this.powerJobs.delete(jobId);
      }
    }

    for (const [tripId, trip] of this.activeTrips.entries()) {
      if (
        trip.originBuildingId === buildingId ||
        trip.destinationBuildingId === buildingId ||
        (trip.serviceJobId !== undefined && !this.powerJobs.has(trip.serviceJobId))
      ) {
        this.activeTrips.delete(tripId);
      }
    }
  }

  private rebuildGraph() {
    this.nodes = [];
    this.edges = [];
    this.adjacency = [];
    this.nodeIdByCoord.clear();

    const getNodeId = (x: number, y: number) => {
      const key = nodeCoordKey(x, y);
      const existingId = this.nodeIdByCoord.get(key);
      if (existingId !== undefined) {
        return existingId;
      }

      const id = this.nodes.length;
      this.nodeIdByCoord.set(key, id);
      this.nodes.push({ id, x, y, queueLength: 0 });
      this.adjacency[id] = [];
      return id;
    };

    for (const segment of this.roads.values()) {
      const fromNodeId = getNodeId(segment.x, segment.y);
      const toNodeId =
        segment.orientation === "horizontal"
          ? getNodeId(segment.x + 1, segment.y)
          : getNodeId(segment.x, segment.y + 1);

      const makeEdge = (fromId: number, toId: number) => {
        const edgeId = this.edges.length;
        const baseTravelTime = 1 / segment.speedLimit;
        const edge: RoadEdge = {
          id: edgeId,
          fromNodeId: fromId,
          toNodeId: toId,
          length: 1,
          speedLimit: segment.speedLimit,
          lanes: segment.lanes,
          capacity: EDGE_CAPACITY_PER_LANE * segment.lanes,
          storage: EDGE_STORAGE_PER_LANE * segment.lanes,
          load: 0,
          utilization: 0,
          travelTime: baseTravelTime,
          blocked: false,
          baseTravelTime
        };

        this.edges.push(edge);
        this.adjacency[fromId].push(edgeId);
      };

      makeEdge(fromNodeId, toNodeId);
      makeEdge(toNodeId, fromNodeId);
    }

    this.networkVersion += 1;
    this.routeCache.clear();
    this.refreshBuildingAccess();

    for (const trip of this.activeTrips.values()) {
      if (trip.currentEdgeId !== null) {
        trip.state = "failed";
      } else {
        trip.routeEdgeIds = [];
      }
    }

    for (const [tripId, trip] of this.activeTrips.entries()) {
      if (trip.state === "failed") {
        this.activeTrips.delete(tripId);
      }
    }
  }

  private moveTrips() {
    for (const node of this.nodes) {
      node.queueLength = 0;
    }

    const completedTrips: number[] = [];

    for (const trip of this.activeTrips.values()) {
      if (trip.state === "moving" && trip.currentEdgeId !== null) {
        trip.edgeTicksRemaining -= 1;
        if (trip.edgeTicksRemaining <= 0) {
          const edge = this.edges[trip.currentEdgeId];
          edge.load = Math.max(0, edge.load - trip.quantity);
          trip.currentNodeId = edge.toNodeId;
          trip.currentEdgeId = null;
          trip.currentLeg += 1;
          trip.edgeTicksRemaining = 0;
          trip.edgeTicksTotal = 0;

          if (trip.currentLeg >= trip.routeEdgeIds.length) {
            trip.state = "complete";
            this.completeTrip(trip);
            completedTrips.push(trip.id);
            continue;
          }

          trip.state = "queued";
        }
      }

      if (trip.state !== "queued") {
        continue;
      }

      const nextEdgeId = trip.routeEdgeIds[trip.currentLeg];
      const nextEdge = this.edges[nextEdgeId];
      if (!nextEdge) {
        completedTrips.push(trip.id);
        continue;
      }

      const turnPenalty = trip.currentLeg > 0 ? 1 : 0;
      if (nextEdge.load + trip.quantity <= nextEdge.storage) {
        nextEdge.load += trip.quantity;
        trip.currentEdgeId = nextEdge.id;
        trip.state = "moving";
        trip.edgeTicksTotal =
          Math.max(1, Math.ceil(nextEdge.travelTime / (SIM_TICK_MS / 1000))) +
          turnPenalty;
        trip.edgeTicksRemaining = trip.edgeTicksTotal;
      } else {
        const node = this.nodes[trip.currentNodeId];
        if (node) {
          node.queueLength += trip.quantity;
        }
      }
    }

    for (const tripId of completedTrips) {
      this.activeTrips.delete(tripId);
    }
  }

  private completeTrip(trip: TripPacket) {
    if (trip.purpose !== "service" || trip.serviceJobId === undefined) {
      return;
    }

    const job = this.powerJobs.get(trip.serviceJobId);
    if (!job) {
      return;
    }

    job.state = "resolved";
    const building = this.buildings.get(job.buildingId);
    if (building) {
      building.outageTicksRemaining = 0;
      building.happiness = clamp(building.happiness + 0.15, 0, 1);
    }

    for (const facility of this.facilities.values()) {
      facility.activeJobIds = facility.activeJobIds.filter((id) => id !== job.id);
    }

    this.pushNotification("Power maintenance crew resolved an outage.", "info");
    this.refreshPowerState();
  }

  private updateEdgeDynamics() {
    for (const edge of this.edges) {
      edge.utilization = edge.load / Math.max(edge.capacity, 1);
      const congestionMultiplier = 1 + Math.pow(edge.utilization, 3) * 1.8;
      const blockedPenalty = edge.load >= edge.storage ? 1.75 : 1;
      edge.travelTime = edge.baseTravelTime * congestionMultiplier * blockedPenalty;
      edge.blocked = edge.load >= edge.storage;
    }
  }

  private generateDemandTrips() {
    if (this.activeTrips.size > 450) {
      return;
    }

    const homes = this.getBuildings().filter(
      (building) =>
        building.kind === "residential" &&
        !building.abandoned &&
        building.powered &&
        building.accessNodeIds.length > 0
    );

    const jobTargets = this.getBuildings().filter(
      (building) =>
        (building.kind === "commercial" || building.kind === "industrial") &&
        !building.abandoned &&
        building.accessNodeIds.length > 0
    );

    const leisureTargets = this.getBuildings().filter(
      (building) =>
        building.kind === "commercial" &&
        !building.abandoned &&
        building.accessNodeIds.length > 0
    );

    const demandBudget = Math.min(48, homes.length);

    for (let index = 0; index < demandBudget; index += 1) {
      const home = homes[this.rng.nextInt(homes.length)];
      if (!home) {
        break;
      }

      const commuteTarget = this.rng.pick(jobTargets);
      if (commuteTarget) {
        this.createTripPacket(
          home.id,
          commuteTarget.id,
          "commute",
          1 + this.rng.nextInt(4)
        );
      }

      if (this.rng.next() > 0.55) {
        const leisureTarget = this.rng.pick(leisureTargets);
        if (leisureTarget) {
          this.createTripPacket(
            home.id,
            leisureTarget.id,
            "commercial",
            1 + this.rng.nextInt(2)
          );
        }
      }
    }

    const cargoOrigins = this.getBuildings().filter(
      (building) =>
        building.kind === "industrial" &&
        !building.abandoned &&
        building.accessNodeIds.length > 0
    );
    const cargoTargets = this.getBuildings().filter(
      (building) =>
        building.kind === "commercial" &&
        !building.abandoned &&
        building.accessNodeIds.length > 0
    );

    if (cargoOrigins.length > 0 && cargoTargets.length > 0) {
      for (let index = 0; index < Math.min(10, cargoOrigins.length); index += 1) {
        const origin = cargoOrigins[this.rng.nextInt(cargoOrigins.length)];
        const destination = cargoTargets[this.rng.nextInt(cargoTargets.length)];
        if (origin && destination) {
          this.createTripPacket(origin.id, destination.id, "cargo", 1);
        }
      }
    }
  }

  private createTripPacket(
    originBuildingId: number,
    destinationBuildingId: number,
    purpose: TripPurpose,
    quantity: number,
    serviceJobId?: number
  ) {
    const originBuilding = this.buildings.get(originBuildingId);
    const destinationBuilding = this.buildings.get(destinationBuildingId);
    if (!originBuilding || !destinationBuilding) {
      return null;
    }

    if (
      originBuilding.accessNodeIds.length === 0 ||
      destinationBuilding.accessNodeIds.length === 0
    ) {
      return null;
    }

    const route = findBestRoute(
      {
        nodes: this.nodes,
        edges: this.edges,
        adjacency: this.adjacency,
        networkVersion: this.networkVersion
      },
      originBuilding.accessNodeIds,
      destinationBuilding.accessNodeIds,
      this.routeCache
    );

    if (!route) {
      return null;
    }

    const packetId = this.ids.tripId++;
    const packet: TripPacket = {
      id: packetId,
      purpose,
      quantity,
      routeEdgeIds: route.edgeIds,
      currentLeg: 0,
      currentNodeId: route.originNodeId,
      currentEdgeId: null,
      edgeTicksRemaining: 0,
      edgeTicksTotal: 0,
      originBuildingId,
      destinationBuildingId,
      state: "queued",
      colorHint: this.rng.nextInt(360),
      serviceJobId
    };

    this.activeTrips.set(packetId, packet);
    return packet;
  }

  private generateOutages() {
    const candidates = this.getBuildings().filter(
      (building) =>
        building.kind !== "powerPlant" &&
        !building.abandoned &&
        building.powered &&
        building.outageTicksRemaining <= 0 &&
        building.accessNodeIds.length > 0 &&
        ![...this.powerJobs.values()].some(
          (job) => job.buildingId === building.id && job.state !== "resolved"
        )
    );

    for (const building of candidates) {
      if (this.rng.next() > 0.025) {
        continue;
      }

      building.outageTicksRemaining = 80 + this.rng.nextInt(80);

      const jobId = this.ids.powerJobId++;
      this.powerJobs.set(jobId, {
        id: jobId,
        buildingId: building.id,
        assignedPacketId: null,
        createdTick: this.tick,
        state: "pending"
      });

      this.pushNotification(
        `Power outage near (${building.cellX}, ${building.cellY}) needs a crew.`,
        "warning"
      );
    }

    this.refreshPowerState();
  }

  private dispatchPowerCrews() {
    const pendingJobs = [...this.powerJobs.values()].filter(
      (job) => job.state === "pending"
    );

    if (pendingJobs.length === 0) {
      return;
    }

    for (const facility of this.facilities.values()) {
      const sourceBuilding = this.buildings.get(facility.buildingId);
      if (!sourceBuilding) {
        continue;
      }

      const unresolvedJobs = facility.activeJobIds.filter((jobId) => {
        const job = this.powerJobs.get(jobId);
        return job && job.state !== "resolved";
      });
      facility.activeJobIds = unresolvedJobs;

      let crewsAvailable = facility.crewCapacity - facility.activeJobIds.length;
      if (crewsAvailable <= 0) {
        continue;
      }

      for (const job of pendingJobs) {
        if (crewsAvailable <= 0 || job.state !== "pending") {
          continue;
        }

        const packet = this.createTripPacket(
          sourceBuilding.id,
          job.buildingId,
          "service",
          1,
          job.id
        );
        if (!packet) {
          continue;
        }

        crewsAvailable -= 1;
        job.state = "assigned";
        job.assignedPacketId = packet.id;
        facility.activeJobIds.push(job.id);
      }
    }
  }

  private updateBuildingsAndEconomy() {
    let roadsUpkeep = this.roads.size * 0.3;
    let facilitiesUpkeep = this.facilities.size * 12;
    let populationIncome = 0;
    this.refreshPowerState();

    for (const building of this.buildings.values()) {
      const accessible = building.accessNodeIds.length > 0;
      if (!building.powered) {
        building.happiness = clamp(building.happiness - 0.08, 0, 1);
      } else if (accessible) {
        building.happiness = clamp(building.happiness + 0.03, 0, 1);
      } else {
        building.happiness = clamp(building.happiness - 0.05, 0, 1);
      }

      if (building.kind === "residential") {
        if (building.powered && accessible && !building.abandoned) {
          building.occupancy = clamp(building.occupancy + 1, 0, 18);
        } else {
          building.occupancy = clamp(building.occupancy - 1, 0, 18);
        }

        populationIncome += building.occupancy * 0.8;
      }

      if (building.kind !== "powerPlant" && !building.powered) {
        building.outageTicksRemaining = Math.max(building.outageTicksRemaining - 20, 0);
      }

      building.abandoned = building.happiness < 0.18;
      if (building.happiness > 0.42) {
        building.abandoned = false;
      }
    }

    this.budget += populationIncome - roadsUpkeep - facilitiesUpkeep;
    this.refreshPowerState();
  }

  private sampleVisibleVehicles() {
    const vehicles: VisibleVehicle[] = [];
    const activeTrips = [...this.activeTrips.values()];
    activeTrips.sort((a, b) => a.id - b.id);

    for (const trip of activeTrips) {
      if (vehicles.length >= MAX_VISIBLE_VEHICLES) {
        break;
      }

      const sampleCount = Math.max(1, Math.ceil(trip.quantity / VEHICLE_SAMPLE_DIVISOR));
      const edge =
        trip.currentEdgeId !== null ? this.edges[trip.currentEdgeId] : null;

      if (trip.state === "moving" && edge) {
        const fromNode = this.nodes[edge.fromNodeId];
        const toNode = this.nodes[edge.toNodeId];
        const ratio =
          trip.edgeTicksTotal > 0
            ? 1 - trip.edgeTicksRemaining / trip.edgeTicksTotal
            : 0;

        for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
          if (vehicles.length >= MAX_VISIBLE_VEHICLES) {
            break;
          }

          const offset = (sampleIndex / Math.max(sampleCount, 1)) * 0.12;
          const x = fromNode.x + (toNode.x - fromNode.x) * clamp(ratio - offset, 0, 1);
          const y = fromNode.y + (toNode.y - fromNode.y) * clamp(ratio - offset, 0, 1);
          vehicles.push({
            id: trip.id * 100 + sampleIndex,
            packetId: trip.id,
            x,
            y,
            heading: Math.atan2(toNode.y - fromNode.y, toNode.x - fromNode.x),
            spriteType: spriteTypeForPurpose(trip.purpose),
            weight: trip.quantity
          });
        }
      } else if (trip.state === "queued") {
        const node = this.nodes[trip.currentNodeId];
        if (!node) {
          continue;
        }

        vehicles.push({
          id: trip.id * 100,
          packetId: trip.id,
          x: node.x + ((trip.id % 3) - 1) * 0.08,
          y: node.y + (((trip.id >> 1) % 3) - 1) * 0.08,
          heading: 0,
          spriteType: spriteTypeForPurpose(trip.purpose),
          weight: trip.quantity
        });
      }
    }

    return vehicles;
  }
}
