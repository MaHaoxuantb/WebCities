import {
  ARTERIAL_ROAD_LANES,
  ARTERIAL_ROAD_SPEED,
  BASE_POWER_PLANT_COST,
  BASE_ROAD_BUILD_COST,
  BASE_ZONE_COST,
  BUILDING_UPDATE_INTERVAL,
  CITY_STAGE_ORDER,
  EDGE_CAPACITY_PER_LANE,
  EDGE_STORAGE_PER_LANE,
  INITIAL_UNLOCKS,
  LOCAL_ROAD_LANES,
  LOCAL_ROAD_SPEED,
  MAX_VISIBLE_VEHICLES,
  MILESTONE_DEFINITIONS,
  OUTAGE_CHECK_INTERVAL,
  SIM_TICK_MS,
  TRIP_GENERATION_INTERVAL,
  VEHICLE_SAMPLE_DIVISOR
} from "../shared/constants";
import {
  getAdjacentRoadKeysForCell,
  getRoadEndpoints,
  getRoadNodeKey,
  getRoadSegmentKey
} from "../shared/roadGeometry";
import { parseSaveGame, type SaveGameV2 } from "../shared/save";
import { createRng, type SeededRng } from "../shared/rng";
import type {
  Building,
  CityStats,
  MilestoneConstraintProgress,
  MilestoneDefinition,
  MilestoneProgress,
  NotificationMessage,
  OverlayKind,
  Orientation,
  PerfStats,
  PowerJob,
  ProgressionState,
  ReplayCommand,
  RoadDirection,
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
  UnlockState,
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

interface BudgetBreakdown {
  populationIncome: number;
  roadsUpkeep: number;
  facilitiesUpkeep: number;
}

interface WorldOptions {
  starterCity?: boolean;
}

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

const cellKey = (x: number, y: number) => `${x},${y}`;

const defaultIds = (): WorldIds => ({
  buildingId: 1,
  facilityId: 1,
  tripId: 1,
  powerJobId: 1,
  notificationId: 1
});

const cloneUnlocks = (unlocks: UnlockState): UnlockState => ({ ...unlocks });

const compareMetric = (
  current: number,
  target: number,
  comparator: "gte" | "lte"
) => (comparator === "gte" ? current >= target : current <= target);

const formatMetric = (value: number) =>
  value >= 1 ? Math.round(value) : Number(value.toFixed(2));

const defaultProgression = (): ProgressionState => ({
  currentStage: "bootstrap",
  threatLevel: 0,
  pressureTier: 1,
  activeMilestoneId: MILESTONE_DEFINITIONS[0]?.id ?? null,
  completedMilestoneIds: [],
  rewardLog: [],
  unlocks: cloneUnlocks(INITIAL_UNLOCKS),
  activeMilestone: null,
  score: 0,
  cityGrade: "D"
});

const getBaseJobsForZone = (zoneType: ZoneType, unlocks: UnlockState) => {
  const multiplier = unlocks.denserZones ? 1.35 : 1;
  if (zoneType === "commercial") {
    return Math.round(8 * multiplier);
  }

  if (zoneType === "industrial") {
    return Math.round(14 * multiplier);
  }

  return 0;
};

const getResidentialSeedOccupancy = (unlocks: UnlockState) =>
  unlocks.denserZones ? 6 : 4;

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

const cityGradeForScore = (score: number) => {
  if (score >= 460) {
    return "S";
  }
  if (score >= 360) {
    return "A";
  }
  if (score >= 270) {
    return "B";
  }
  if (score >= 180) {
    return "C";
  }
  return "D";
};

export class SimWorld {
  width: number;
  height: number;
  seed: number;
  tick = 0;
  budget = 2500;
  timeScale: TimeScale = 1;
  overlay: OverlayKind = "none";
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

  private progression: ProgressionState = defaultProgression();
  private positiveBudgetStreak = 0;
  private longestPositiveBudgetStreak = 0;
  private tripAttemptsWindow = 0;
  private tripCompletionsWindow = 0;
  private tripFailuresWindow = 0;

  private rng: SeededRng;
  private readonly nodeIdByCoord = new Map<string, number>();

  nodes: RoadNode[] = [];
  edges: RoadEdge[] = [];
  adjacency: number[][] = [];

  constructor(width: number, height: number, seed: number, options: WorldOptions = {}) {
    this.width = width;
    this.height = height;
    this.seed = seed;
    this.rng = createRng(seed);

    if (options.starterCity) {
      this.seedStarterCity();
    }

    this.progression.activeMilestone = this.buildMilestoneProgress(
      MILESTONE_DEFINITIONS[0],
      this.computeStats()
    );
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
    world.progression = {
      ...save.progression,
      unlocks: cloneUnlocks(save.progression.unlocks),
      rewardLog: [...save.progression.rewardLog],
      completedMilestoneIds: [...save.progression.completedMilestoneIds],
      activeMilestone: save.progression.activeMilestone
    };
    world.positiveBudgetStreak = save.positiveBudgetStreak;
    world.longestPositiveBudgetStreak = save.longestPositiveBudgetStreak;
    world.tripAttemptsWindow = save.tripAttemptsWindow;
    world.tripCompletionsWindow = save.tripCompletionsWindow;
    world.tripFailuresWindow = save.tripFailuresWindow;

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
    world.syncUnlockedInfrastructure();
    world.evaluateProgression();
    return world;
  }

  serialize(): SaveGameV2 {
    this.evaluateProgression();

    return {
      version: 2,
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
      replayLog: [...this.replayLog],
      progression: this.progression,
      positiveBudgetStreak: this.positiveBudgetStreak,
      longestPositiveBudgetStreak: this.longestPositiveBudgetStreak,
      tripAttemptsWindow: this.tripAttemptsWindow,
      tripCompletionsWindow: this.tripCompletionsWindow,
      tripFailuresWindow: this.tripFailuresWindow
    };
  }

  consumeNotifications() {
    const notifications = [...this.pendingNotifications];
    this.pendingNotifications.length = 0;
    return notifications;
  }

  getSnapshot(simulationAlpha = 0): SimSnapshot {
    const cityStats = this.computeStats();
    const progression = this.evaluateProgression(cityStats);

    return {
      tick: this.tick,
      timeScale: this.timeScale,
      simulationAlpha,
      roads: this.getRoads(),
      nodes: this.nodes.map((node) => ({ ...node })),
      edges: this.edges.map((edge) => ({ ...edge })),
      zones: this.getZones(),
      buildings: this.getBuildings(),
      services: this.getFacilities(),
      vehicles: this.sampleVisibleVehicles(simulationAlpha),
      cityStats,
      perfStats: this.computePerfStats(),
      overlay: this.overlay,
      progression
    };
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
      const key = getRoadSegmentKey(road.x, road.y, road.orientation);
      const existingRoad = this.roads.get(key);
      if (existingRoad) {
        this.roads.delete(key);
        this.budget += this.getRoadRefund(existingRoad);
        didChange = true;
        this.rebuildGraph();
      }
    }

    if (!didChange && this.isValidCell(cellX, cellY)) {
      const existingBuildingId = this.buildingByCell.get(cellKey(cellX, cellY));
      const existingBuilding =
        existingBuildingId !== undefined
          ? this.buildings.get(existingBuildingId)
          : undefined;
      didChange = this.removeCellContents(cellX, cellY);
      if (didChange && existingBuilding?.kind === "powerPlant") {
        this.budget += this.getPowerPlantRefund();
        this.pushNotification("Power plant sold back to the city budget.", "info");
      }
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

    const key = getRoadSegmentKey(x, y, orientation);
    const existing = this.roads.get(key);

    if (mode === "add") {
      if (
        existing &&
        existing.lanes === this.getRoadLanes() &&
        existing.speedLimit === this.getRoadSpeed()
      ) {
        return;
      }

      const cost = this.getRoadBuildCost();
      if (!this.spendBudget(cost, "road work")) {
        return;
      }

      this.upsertRoadSegment(
        x,
        y,
        orientation,
        this.getRoadLanes(),
        this.getRoadSpeed()
      );
    } else {
      if (!existing) {
        return;
      }
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
      const existingZone = this.zones.get(key);
      if (existingZone?.zoneType !== zoneType) {
        const cost = this.getZonePlacementCost(zoneType);
        if (!this.spendBudget(cost, `${zoneType} zoning`)) {
          return;
        }
      }

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
      outageTicksRemaining: 0,
      serviceReliability: 0.72,
      throughputScore: 0.72,
      productivity: 0.72,
      recentOutageTicks: 0
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
    }

    const cost = this.getPowerPlantCost();
    if (!this.spendBudget(cost, "power construction")) {
      return;
    }

    if (existingBuildingId) {
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
      jobs: this.progression.unlocks.advancedPowerPlants ? 26 : 20,
      powered: true,
      happiness: 1,
      abandoned: false,
      accessNodeIds: [],
      outageTicksRemaining: 0,
      serviceReliability: 1,
      throughputScore: 1,
      productivity: 1,
      recentOutageTicks: 0
    };
    this.buildings.set(buildingId, building);
    this.buildingByCell.set(slotKey, buildingId);

    const facilityId = this.ids.facilityId++;
    this.facilities.set(facilityId, {
      id: facilityId,
      buildingId,
      kind,
      crewCapacity: this.getPlantCrewCapacity(),
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
      powerJobs: this.getPowerJobs(),
      progression: this.progression
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

  private getRoadLanes() {
    return this.progression.unlocks.arterialRoads ? ARTERIAL_ROAD_LANES : LOCAL_ROAD_LANES;
  }

  private getRoadSpeed() {
    return this.progression.unlocks.arterialRoads ? ARTERIAL_ROAD_SPEED : LOCAL_ROAD_SPEED;
  }

  private getPlantCrewCapacity() {
    return this.progression.unlocks.advancedPowerPlants ? 3 : 2;
  }

  private getOccupancyCap() {
    const denseBonus = this.progression.unlocks.denserZones ? 4 : 0;
    return 18 + denseBonus + this.progression.unlocks.occupancyCapBonus;
  }

  private getRoadBuildCost() {
    const stageIndex = CITY_STAGE_ORDER.indexOf(this.progression.currentStage);
    return Math.round(
      BASE_ROAD_BUILD_COST * (1 + stageIndex * 0.18 + this.roads.size / 220)
    );
  }

  private getZonePlacementCost(zoneType: ZoneType) {
    const stageIndex = CITY_STAGE_ORDER.indexOf(this.progression.currentStage);
    return Math.round(
      BASE_ZONE_COST[zoneType] * (1 + stageIndex * 0.12 + this.zones.size / 260)
    );
  }

  private getPowerPlantCost() {
    return Math.round(
      BASE_POWER_PLANT_COST *
        (1 +
          Math.max(0, this.facilities.size - 1) * 0.18 +
          Math.max(0, this.progression.pressureTier - 1) * 0.06)
    );
  }

  private getPowerPlantRefund() {
    return this.getPowerPlantCost();
  }

  private getRoadRefund(road: RoadSegment) {
    return Math.round(
      (BASE_ROAD_BUILD_COST + road.lanes * 5 + road.speedLimit * 10) * 0.7
    );
  }

  private spendBudget(cost: number, reason: string) {
    if (this.budget < cost) {
      this.pushNotification(
        `Not enough cash for ${reason}. Need ${cost}, have ${Math.floor(this.budget)}.`,
        "warning"
      );
      return false;
    }

    this.budget -= cost;
    return true;
  }

  private computeTripCompletionRate() {
    const attempts = Math.max(1, this.tripAttemptsWindow);
    return clamp(this.tripCompletionsWindow / attempts, 0, 1);
  }

  private computeDebtPressure() {
    if (this.budget >= 0) {
      return 0;
    }

    return clamp(Math.abs(this.budget) / 12, 0, 100);
  }

  private computeCongestionStress() {
    if (this.edges.length === 0) {
      return 0;
    }

    const totalUtilization = this.edges.reduce((sum, edge) => sum + edge.utilization, 0);
    const blockedEdges = this.edges.filter((edge) => edge.blocked).length;
    const queuedTrips = [...this.activeTrips.values()].filter(
      (trip) => trip.state === "queued"
    ).length;

    return clamp(
      totalUtilization / this.edges.length +
        blockedEdges / Math.max(1, this.edges.length) +
        queuedTrips / 60,
      0,
      1
    );
  }

  private computeStats(): CityStats {
    const budgetBreakdown = this.computeBudgetBreakdown();
    let population = 0;
    let jobs = 0;
    let productiveJobs = 0;
    let residentialCount = 0;
    let commercialCount = 0;
    let industrialCount = 0;
    let totalBuildings = 0;
    let poweredBuildings = 0;
    let powerPlants = 0;
    let totalServiceReliability = 0;
    let serviceReliabilityCount = 0;

    for (const building of this.buildings.values()) {
      jobs += building.jobs;

      if (building.kind === "powerPlant") {
        powerPlants += 1;
        continue;
      }

      totalBuildings += 1;
      if (building.powered) {
        poweredBuildings += 1;
      }

      totalServiceReliability += building.serviceReliability;
      serviceReliabilityCount += 1;

      if (building.kind === "residential") {
        population += building.occupancy;
      } else {
        productiveJobs += building.jobs * building.productivity;
      }

      if (building.abandoned) {
        continue;
      }

      if (building.kind === "residential") {
        residentialCount += 1;
      } else if (building.kind === "commercial") {
        commercialCount += 1;
      } else if (building.kind === "industrial") {
        industrialCount += 1;
      }
    }

    let queuedTrips = 0;
    for (const trip of this.activeTrips.values()) {
      if (trip.state === "queued") {
        queuedTrips += 1;
      }
    }

    let activeEdgeCount = 0;
    let totalTravelTime = 0;
    for (const edge of this.edges) {
      if (edge.load <= 0) {
        continue;
      }

      activeEdgeCount += 1;
      totalTravelTime += edge.travelTime;
    }

    const avgTravelTime = activeEdgeCount > 0 ? totalTravelTime / activeEdgeCount : 0;
    let outages = 0;
    for (const job of this.powerJobs.values()) {
      if (job.state !== "resolved") {
        outages += 1;
      }
    }

    const tripCompletionRate = this.computeTripCompletionRate();
    const avgServiceReliability =
      serviceReliabilityCount > 0 ? totalServiceReliability / serviceReliabilityCount : 0;
    const congestionStress = this.computeCongestionStress();
    const budgetDelta =
      budgetBreakdown.populationIncome -
      budgetBreakdown.roadsUpkeep -
      budgetBreakdown.facilitiesUpkeep;
    const debtPressure = this.computeDebtPressure();

    return {
      tick: this.tick,
      population,
      jobs,
      productiveJobs,
      activeTrips: this.activeTrips.size,
      queuedTrips,
      avgTravelTime,
      tripCompletionRate,
      avgServiceReliability,
      congestionStress,
      budget: this.budget,
      budgetIncome: budgetBreakdown.populationIncome,
      roadsUpkeep: budgetBreakdown.roadsUpkeep,
      facilitiesUpkeep: budgetBreakdown.facilitiesUpkeep,
      budgetDelta,
      positiveBudgetStreak: this.positiveBudgetStreak,
      debtPressure,
      demandResidential: clamp((productiveJobs - population) * 0.8 + 52, 0, 100),
      demandCommercial: clamp(
        population > 0 ? (commercialCount / Math.max(1, residentialCount)) * 38 : 35,
        0,
        100
      ),
      demandIndustrial: clamp(
        population > 0 ? (industrialCount / Math.max(1, population / 14)) * 54 : 30,
        0,
        100
      ),
      outages,
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
        this.buildings.size * 88 +
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
        existingBuilding.jobs = getBaseJobsForZone(
          zoneCell.zoneType,
          this.progression.unlocks
        );
        if (zoneCell.zoneType === "residential") {
          existingBuilding.occupancy = clamp(
            existingBuilding.occupancy,
            0,
            this.getOccupancyCap()
          );
        } else {
          existingBuilding.occupancy = 0;
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
      occupancy:
        zoneCell.zoneType === "residential"
          ? getResidentialSeedOccupancy(this.progression.unlocks)
          : 0,
      jobs: getBaseJobsForZone(zoneCell.zoneType, this.progression.unlocks),
      powered: true,
      happiness: 0.7,
      abandoned: false,
      accessNodeIds: this.resolveBuildingAccess(zoneCell.x, zoneCell.y),
      outageTicksRemaining: 0,
      serviceReliability: 0.66,
      throughputScore: 0.66,
      productivity: 0.66,
      recentOutageTicks: 0
    });
    this.buildingByCell.set(zoneCell.cellKey, buildingId);
  }

  private resolveBuildingAccess(x: number, y: number) {
    const candidates = new Set<number>();
    const roadKeys = getAdjacentRoadKeysForCell(x, y);
    const top = this.roads.get(roadKeys.top);
    const bottom = this.roads.get(roadKeys.bottom);
    const left = this.roads.get(roadKeys.left);
    const right = this.roads.get(roadKeys.right);

    const collectNodes = (segment: RoadSegment | undefined) => {
      if (!segment) {
        return;
      }

      const [start, end] = getRoadEndpoints(segment);
      const a = this.nodeIdByCoord.get(getRoadNodeKey(start.x, start.y));
      const b = this.nodeIdByCoord.get(getRoadNodeKey(end.x, end.y));
      if (a !== undefined) {
        candidates.add(a);
      }
      if (b !== undefined) {
        candidates.add(b);
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
    let queueIndex = 0;

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

    while (queueIndex < queue.length) {
      const nodeId = queue[queueIndex];
      queueIndex += 1;
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

  private seedStarterCity() {
    if (this.width < 12 || this.height < 12) {
      return;
    }

    const startX = Math.min(6, this.width - 6);
    const startY = Math.min(6, this.height - 6);

    for (let x = startX; x < startX + 6; x += 1) {
      this.upsertRoadSegment(x, startY + 2, "horizontal", LOCAL_ROAD_LANES, LOCAL_ROAD_SPEED);
    }
    for (let y = startY; y < startY + 5; y += 1) {
      this.upsertRoadSegment(startX + 3, y, "vertical", LOCAL_ROAD_LANES, LOCAL_ROAD_SPEED);
    }

    this.rebuildGraph();

    const starterZones: Array<{ x: number; y: number; zoneType: ZoneType }> = [
      { x: startX + 1, y: startY + 1, zoneType: "residential" },
      { x: startX + 2, y: startY + 1, zoneType: "residential" },
      { x: startX + 1, y: startY + 2, zoneType: "residential" },
      { x: startX + 2, y: startY + 2, zoneType: "residential" },
      { x: startX + 3, y: startY + 1, zoneType: "commercial" },
      { x: startX + 3, y: startY + 2, zoneType: "industrial" }
    ];

    for (const zone of starterZones) {
      const zoneCell: ZoneCell = {
        cellKey: cellKey(zone.x, zone.y),
        x: zone.x,
        y: zone.y,
        zoneType: zone.zoneType
      };
      this.zones.set(zoneCell.cellKey, zoneCell);
      this.upsertZonedBuilding(zoneCell);
    }

    const buildingId = this.ids.buildingId++;
    this.buildings.set(buildingId, {
      id: buildingId,
      cellX: startX,
      cellY: startY + 1,
      kind: "powerPlant",
      occupancy: 0,
      jobs: 20,
      powered: true,
      happiness: 1,
      abandoned: false,
      accessNodeIds: this.resolveBuildingAccess(startX, startY + 1),
      outageTicksRemaining: 0,
      serviceReliability: 1,
      throughputScore: 1,
      productivity: 1,
      recentOutageTicks: 0
    });
    this.buildingByCell.set(cellKey(startX, startY + 1), buildingId);

    const facilityId = this.ids.facilityId++;
    this.facilities.set(facilityId, {
      id: facilityId,
      buildingId,
      kind: "power",
      crewCapacity: this.getPlantCrewCapacity(),
      activeJobIds: []
    });

    this.refreshBuildingAccess();

    for (const building of this.buildings.values()) {
      if (building.kind === "powerPlant") {
        continue;
      }

      building.happiness = 0.92;
      building.serviceReliability = 1;
      building.throughputScore = 0.92;
      building.productivity = 0.9;
    }

    this.pushNotification(
      "Founding block online: expand the starter district without losing positive cash flow.",
      "info"
    );
  }

  private upsertRoadSegment(
    x: number,
    y: number,
    orientation: Orientation,
    lanes: number,
    speedLimit: number,
    direction: RoadDirection = "both"
  ) {
    const key = getRoadSegmentKey(x, y, orientation);
    this.roads.set(key, {
      key,
      x,
      y,
      orientation,
      direction,
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
        this.registerTripFailure(trip.quantity);
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
      const key = getRoadNodeKey(x, y);
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
      const [fromNode, toNode] = getRoadEndpoints(segment);
      const fromNodeId = getNodeId(fromNode.x, fromNode.y);
      const toNodeId = getNodeId(toNode.x, toNode.y);

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

      if (segment.direction === "both" || segment.direction === "forward") {
        makeEdge(fromNodeId, toNodeId);
      }

      if (segment.direction === "both" || segment.direction === "reverse") {
        makeEdge(toNodeId, fromNodeId);
      }
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
        this.registerTripFailure(trip.quantity);
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
        this.registerTripFailure(trip.quantity);
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
    this.tripCompletionsWindow += trip.quantity;

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
      building.recentOutageTicks = Math.max(0, building.recentOutageTicks - 40);
      building.serviceReliability = clamp(building.serviceReliability + 0.18, 0, 1);
      building.happiness = clamp(building.happiness + 0.08, 0, 1);
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
    if (this.activeTrips.size > 500 + this.progression.pressureTier * 40) {
      return;
    }

    const completionRate = this.computeTripCompletionRate();
    const healthyHomes = this.getBuildings().filter(
      (building) =>
        building.kind === "residential" &&
        !building.abandoned &&
        building.powered &&
        building.accessNodeIds.length > 0 &&
        building.productivity > 0.48
    );

    const jobTargets = this.getBuildings().filter(
      (building) =>
        (building.kind === "commercial" || building.kind === "industrial") &&
        !building.abandoned &&
        building.accessNodeIds.length > 0 &&
        building.productivity > 0.35
    );

    const leisureTargets = this.getBuildings().filter(
      (building) =>
        building.kind === "commercial" &&
        !building.abandoned &&
        building.accessNodeIds.length > 0 &&
        building.productivity > 0.3
    );

    const demandBudget = Math.min(
      52 + this.progression.pressureTier * 4,
      healthyHomes.length
    );

    for (let index = 0; index < demandBudget; index += 1) {
      const home = healthyHomes[this.rng.nextInt(healthyHomes.length)];
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

      if (this.rng.next() > 0.58 - completionRate * 0.18) {
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
        building.accessNodeIds.length > 0 &&
        building.productivity > 0.28
    );
    const cargoTargets = this.getBuildings().filter(
      (building) =>
        building.kind === "commercial" &&
        !building.abandoned &&
        building.accessNodeIds.length > 0 &&
        building.productivity > 0.28
    );

    if (cargoOrigins.length > 0 && cargoTargets.length > 0) {
      const cargoBudget = Math.min(12 + this.progression.pressureTier * 2, cargoOrigins.length);
      for (let index = 0; index < cargoBudget; index += 1) {
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
    this.tripAttemptsWindow += quantity;

    const originBuilding = this.buildings.get(originBuildingId);
    const destinationBuilding = this.buildings.get(destinationBuildingId);
    if (!originBuilding || !destinationBuilding) {
      this.registerTripFailure(quantity);
      return null;
    }

    if (
      originBuilding.accessNodeIds.length === 0 ||
      destinationBuilding.accessNodeIds.length === 0
    ) {
      this.registerTripFailure(quantity);
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
      this.registerTripFailure(quantity);
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

  private registerTripFailure(quantity: number) {
    this.tripFailuresWindow += quantity;
  }

  private generateOutages() {
    const debtPressure = this.computeDebtPressure();
    const outageRisk =
      0.018 +
      this.progression.pressureTier * 0.004 +
      this.computeCongestionStress() * 0.018 +
      debtPressure * 0.0005;

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
      if (this.rng.next() > outageRisk) {
        continue;
      }

      building.outageTicksRemaining = 95 + this.rng.nextInt(110);
      building.recentOutageTicks += 25;

      const jobId = this.ids.powerJobId++;
      this.powerJobs.set(jobId, {
        id: jobId,
        buildingId: building.id,
        assignedPacketId: null,
        createdTick: this.tick,
        state: "pending"
      });

      this.pushNotification(
        `Grid stress rising near (${building.cellX}, ${building.cellY}); a crew is needed.`,
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

    const debtPenalty = this.computeDebtPressure() >= 55 ? 1 : 0;

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

      let crewsAvailable =
        Math.max(1, facility.crewCapacity - debtPenalty) - facility.activeJobIds.length;
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

  private getAverageQueuePressure(building: Building) {
    if (building.accessNodeIds.length === 0) {
      return 1;
    }

    let totalQueue = 0;
    for (const nodeId of building.accessNodeIds) {
      totalQueue += this.nodes[nodeId]?.queueLength ?? 0;
    }

    return clamp(totalQueue / Math.max(1, building.accessNodeIds.length * 6), 0, 1);
  }

  private updateBuildingsAndEconomy() {
    this.refreshPowerState();
    const preStats = this.computeStats();
    let populationIncome = 0;
    const economicPressure = clamp(
      (preStats.productiveJobs - preStats.population) / 120,
      -1,
      1
    );
    const debtPressure = preStats.debtPressure;
    const congestionStress = preStats.congestionStress;
    const completionRate = preStats.tripCompletionRate;

    for (const building of this.buildings.values()) {
      const accessible = building.accessNodeIds.length > 0;
      const queuePressure = this.getAverageQueuePressure(building);
      const outageBurden = clamp(building.recentOutageTicks / 180, 0, 1);

      if (building.kind === "powerPlant") {
        building.serviceReliability = 1;
        building.throughputScore = 1;
        building.productivity = 1;
        continue;
      }

      if (!building.powered) {
        building.recentOutageTicks += 12;
        building.serviceReliability = clamp(
          building.serviceReliability - 0.12 - debtPressure * 0.0015,
          0,
          1
        );
      } else {
        building.recentOutageTicks = Math.max(0, building.recentOutageTicks - 8);
        building.serviceReliability = clamp(
          building.serviceReliability + 0.02 - outageBurden * 0.01,
          0,
          1
        );
      }

      building.throughputScore = clamp(
        (accessible ? 1 : 0) -
          queuePressure * 0.7 -
          congestionStress * 0.4 -
          debtPressure * 0.002,
        0,
        1
      );
      building.productivity = clamp(
        building.serviceReliability * building.throughputScore,
        0,
        1
      );

      let happinessDelta = 0;
      if (!building.powered) {
        happinessDelta -= 0.12 + outageBurden * 0.04;
      } else if (!accessible) {
        happinessDelta -= 0.08;
      } else {
        happinessDelta += 0.01 + building.productivity * 0.03;
      }

      if (building.throughputScore < 0.45) {
        happinessDelta -= 0.04;
      }
      if (building.serviceReliability < 0.55) {
        happinessDelta -= 0.03;
      }
      if (debtPressure > 45) {
        happinessDelta -= 0.03;
      }

      building.happiness = clamp(building.happiness + happinessDelta, 0, 1);

      if (building.kind === "residential") {
        const cap = this.getOccupancyCap();
        if (
          building.powered &&
          accessible &&
          !building.abandoned &&
          building.productivity > 0.58 &&
          completionRate > 0.45 &&
          economicPressure > -0.2
        ) {
          const growth =
            building.productivity > 0.8 && economicPressure > 0.35 && building.happiness > 0.7
              ? 2
              : 1;
          building.occupancy = clamp(building.occupancy + growth, 0, cap);
        } else if (!building.powered || !accessible || building.productivity < 0.32) {
          building.occupancy = clamp(building.occupancy - 1, 0, cap);
        }

        populationIncome += building.occupancy * 0.8 * building.serviceReliability;
      }

      if (building.outageTicksRemaining > 0) {
        building.outageTicksRemaining = Math.max(building.outageTicksRemaining - 8, 0);
      }

      building.abandoned = building.happiness < 0.2;
      if (building.happiness > 0.58) {
        building.abandoned = false;
      }
    }

    const budgetBreakdown = this.computeBudgetBreakdown(populationIncome);
    let maintenancePenalty = 0;
    if (this.budget < 0) {
      maintenancePenalty =
        this.roads.size * 0.05 * this.progression.pressureTier + this.facilities.size * 1.2;
    }

    this.budget +=
      populationIncome -
      budgetBreakdown.roadsUpkeep -
      budgetBreakdown.facilitiesUpkeep -
      maintenancePenalty;

    const netCycle =
      populationIncome -
      budgetBreakdown.roadsUpkeep -
      budgetBreakdown.facilitiesUpkeep -
      maintenancePenalty;
    if (netCycle >= 0) {
      this.positiveBudgetStreak += 1;
      this.longestPositiveBudgetStreak = Math.max(
        this.longestPositiveBudgetStreak,
        this.positiveBudgetStreak
      );
    } else {
      if (this.positiveBudgetStreak >= 4) {
        this.pushNotification("Budget streak broken. Maintenance pressure is climbing.", "warning");
      }
      this.positiveBudgetStreak = 0;
    }

    if (completionRate < 0.4 && this.tick % (BUILDING_UPDATE_INTERVAL * 3) === 0) {
      this.pushNotification("Industrial district stalling: trip completion is too low.", "warning");
    }

    this.tripAttemptsWindow = Math.round(this.tripAttemptsWindow * 0.45);
    this.tripCompletionsWindow = Math.round(this.tripCompletionsWindow * 0.45);
    this.tripFailuresWindow = Math.round(this.tripFailuresWindow * 0.45);

    this.refreshPowerState();
    this.evaluateProgression();
  }

  private computeBudgetBreakdown(populationIncomeOverride?: number): BudgetBreakdown {
    let populationIncome = 0;
    for (const building of this.buildings.values()) {
      if (building.kind === "residential") {
        populationIncome += building.occupancy * 0.8 * building.serviceReliability;
      }
    }

    return {
      populationIncome: populationIncomeOverride ?? populationIncome,
      roadsUpkeep: this.getRoads().reduce(
        (sum, road) => sum + road.lanes * 0.3 + road.speedLimit * 0.12,
        0
      ),
      facilitiesUpkeep: this.getFacilities().reduce(
        (sum, facility) => sum + facility.crewCapacity * 4,
        0
      )
    };
  }

  private buildConstraintProgress(
    label: string,
    current: number,
    target: number,
    comparator: "gte" | "lte"
  ): MilestoneConstraintProgress {
    return {
      label,
      current,
      target,
      comparator,
      complete: compareMetric(current, target, comparator)
    };
  }

  private buildMilestoneProgress(
    definition: MilestoneDefinition,
    stats: CityStats
  ): MilestoneProgress {
    const primary = this.buildConstraintProgress(
      definition.primaryLabel,
      stats[definition.primaryMetric],
      definition.primaryTarget,
      definition.primaryComparator
    );
    const secondary = definition.secondary.map((constraint) =>
      this.buildConstraintProgress(
        constraint.label,
        stats[constraint.metric],
        constraint.target,
        constraint.comparator
      )
    );
    const blockers = [
      ...(!primary.complete
        ? [
            `${primary.label}: ${formatMetric(primary.current)} / ${formatMetric(primary.target)}`
          ]
        : []),
      ...secondary
        .filter((constraint) => !constraint.complete)
        .map(
          (constraint) =>
            `${constraint.label}: ${formatMetric(constraint.current)} / ${formatMetric(
              constraint.target
            )}`
        )
    ];

    return {
      id: definition.id,
      stage: definition.stage,
      title: definition.title,
      summary: definition.summary,
      rewardText: definition.rewardText,
      primary,
      secondary,
      blockers,
      complete: primary.complete && secondary.every((constraint) => constraint.complete)
    };
  }

  private updateScore(stats: CityStats) {
    const milestoneScore = this.progression.completedMilestoneIds.length * 85;
    const populationScore = stats.population * 0.7;
    const reliabilityScore = stats.avgServiceReliability * 90;
    const trafficScore = (1 - stats.congestionStress) * 80;
    const budgetScore = Math.min(60, this.longestPositiveBudgetStreak * 8);
    const score = Math.round(
      milestoneScore + populationScore + reliabilityScore + trafficScore + budgetScore
    );

    this.progression.score = score;
    this.progression.cityGrade = cityGradeForScore(score);
  }

  private applyMilestoneReward(milestoneId: MilestoneDefinition["id"]) {
    switch (milestoneId) {
      case "bootstrap-power":
        this.budget += 600;
        this.progression.unlocks.denserZones = true;
        break;
      case "town-growth":
        this.budget += 900;
        this.progression.unlocks.arterialRoads = true;
        break;
      case "logistics-flow":
        this.budget += 1200;
        this.progression.unlocks.advancedPowerPlants = true;
        break;
      case "resilience-run":
        this.budget += 1500;
        this.progression.unlocks.occupancyCapBonus += 4;
        break;
      default:
        break;
    }

    this.syncUnlockedInfrastructure();
  }

  private syncUnlockedInfrastructure() {
    for (const building of this.buildings.values()) {
      if (building.kind === "commercial" || building.kind === "industrial") {
        building.jobs = getBaseJobsForZone(
          building.kind,
          this.progression.unlocks
        );
      }

      if (building.kind === "residential") {
        building.occupancy = clamp(building.occupancy, 0, this.getOccupancyCap());
      }

      if (building.kind === "powerPlant") {
        building.jobs = this.progression.unlocks.advancedPowerPlants ? 26 : 20;
      }
    }

    for (const facility of this.facilities.values()) {
      facility.crewCapacity = this.getPlantCrewCapacity();
    }
  }

  private evaluateProgression(stats = this.computeStats()): ProgressionState {
    const activeDefinition = MILESTONE_DEFINITIONS.find(
      (definition) => !this.progression.completedMilestoneIds.includes(definition.id)
    );

    if (activeDefinition) {
      this.progression.currentStage = activeDefinition.stage;
      this.progression.activeMilestoneId = activeDefinition.id;
      this.progression.activeMilestone = this.buildMilestoneProgress(activeDefinition, stats);

      if (this.progression.activeMilestone.complete) {
        this.progression.completedMilestoneIds = [
          ...this.progression.completedMilestoneIds,
          activeDefinition.id
        ];
        this.progression.rewardLog = [
          activeDefinition.rewardText,
          ...this.progression.rewardLog
        ].slice(0, 6);
        this.applyMilestoneReward(activeDefinition.id);
        this.pushNotification(`Milestone achieved: ${activeDefinition.rewardText}`, "info");
        return this.evaluateProgression(this.computeStats());
      }
    } else {
      this.progression.activeMilestoneId = null;
      this.progression.activeMilestone = null;
      this.progression.currentStage = "resilience";
    }

    const threatLevel = clamp(
      stats.congestionStress * 44 +
        (1 - stats.tripCompletionRate) * 28 +
        stats.outages * 7 +
        stats.debtPressure * 0.42,
      0,
      100
    );
    const pressureTier = Math.min(4, Math.max(1, 1 + Math.floor(threatLevel / 25)));
    if (pressureTier > this.progression.pressureTier) {
      this.pushNotification(`Threat tier ${pressureTier} reached. The city is under harder pressure.`, "warning");
    }

    this.progression.threatLevel = threatLevel;
    this.progression.pressureTier = pressureTier;
    this.updateScore(stats);
    return this.progression;
  }

  private sampleVisibleVehicles(simulationAlpha = 0) {
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
            ? 1 -
              Math.max(0, trip.edgeTicksRemaining - simulationAlpha) / trip.edgeTicksTotal
            : 0;

        for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
          if (vehicles.length >= MAX_VISIBLE_VEHICLES) {
            break;
          }

          const offset = (sampleIndex / Math.max(sampleCount, 1)) * 0.12;
          const adjustedRatio = clamp(ratio - offset, 0, 1);
          const x = fromNode.x + (toNode.x - fromNode.x) * adjustedRatio;
          const y = fromNode.y + (toNode.y - fromNode.y) * adjustedRatio;
          const heading = Math.atan2(toNode.y - fromNode.y, toNode.x - fromNode.x);

          vehicles.push({
            id: trip.id * 100 + sampleIndex,
            packetId: trip.id,
            x,
            y,
            heading,
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
