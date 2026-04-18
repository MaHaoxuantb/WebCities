import { describe, expect, it } from "vitest";

import { SimWorld } from "../src/worker/world";

const buildingIdAt = (world: SimWorld, cellX: number, cellY: number) =>
  world
    .debugState()
    .buildings.find((building) => building.cellX === cellX && building.cellY === cellY)
    ?.id;

describe("SimWorld", () => {
  it("builds a directed graph from grid road segments", () => {
    const world = new SimWorld(8, 8, 123);
    world.editRoad(0, 1, "horizontal", "add");
    world.editRoad(1, 1, "horizontal", "add");

    expect(world.nodes).toHaveLength(3);
    expect(world.edges).toHaveLength(4);
    expect(world.adjacency[0]).toHaveLength(1);
    expect(world.adjacency[1]).toHaveLength(2);
  });

  it("finds routes between accessible zoned buildings", () => {
    const world = new SimWorld(8, 8, 123);
    world.editRoad(0, 1, "horizontal", "add");
    world.editRoad(1, 1, "horizontal", "add");
    world.editRoad(2, 1, "horizontal", "add");
    world.editZone(0, 0, "residential");
    world.editZone(2, 0, "commercial");

    const originId = buildingIdAt(world, 0, 0);
    const destinationId = buildingIdAt(world, 2, 0);
    expect(originId).toBeDefined();
    expect(destinationId).toBeDefined();

    const route = world.debugRouteBetweenBuildings(originId!, destinationId!);
    expect(route).not.toBeNull();
    expect(route?.edgeIds.length).toBeGreaterThan(0);
  });

  it("keeps trips queued when the next edge has no storage", () => {
    const world = new SimWorld(8, 8, 123);
    world.editRoad(0, 1, "horizontal", "add");
    world.editRoad(1, 1, "horizontal", "add");
    world.editRoad(2, 1, "horizontal", "add");
    world.editZone(0, 0, "residential");
    world.editZone(2, 0, "commercial");

    const originId = buildingIdAt(world, 0, 0)!;
    const destinationId = buildingIdAt(world, 2, 0)!;
    const packet = world.debugCreateTrip(originId, destinationId, "commute", 1);
    expect(packet).not.toBeNull();

    const firstEdgeId = packet!.routeEdgeIds[0];
    world.edges[firstEdgeId].storage = 0;
    world.tickOnce();

    const activePacket = world.debugState().activeTrips.find((trip) => trip.id === packet!.id);
    expect(activePacket?.state).toBe("queued");
    expect(world.nodes[activePacket!.currentNodeId].queueLength).toBeGreaterThan(0);
  });

  it("round-trips saves through the versioned schema", () => {
    const world = new SimWorld(8, 8, 123);
    world.editRoad(0, 1, "horizontal", "add");
    world.editZone(0, 0, "residential");
    world.placeService(1, 0, "power");
    world.tickOnce();

    const save = world.serialize();
    const restored = SimWorld.fromSave(save);

    expect(restored.serialize()).toMatchObject({
      version: 2,
      roads: save.roads,
      zones: save.zones,
      progression: save.progression
    });
    expect(restored.debugState().buildings).toHaveLength(world.debugState().buildings.length);
  });

  it("bulldozes either roads or cell contents depending on target", () => {
    const world = new SimWorld(8, 8, 123);
    world.editRoad(0, 1, "horizontal", "add");
    world.editZone(0, 0, "residential");
    expect(world.debugState().buildings).toHaveLength(1);

    world.bulldozeAt(0, 0, null);
    expect(world.debugState().buildings).toHaveLength(0);

    world.editRoad(0, 1, "horizontal", "add");
    expect(world.getSnapshot().roads).toHaveLength(1);
    world.bulldozeAt(0, 0, { x: 0, y: 1, orientation: "horizontal" });
    expect(world.getSnapshot().roads).toHaveLength(0);
  });

  it("powers buildings only when they can reach a power plant through roads", () => {
    const world = new SimWorld(10, 10, 123);
    world.editRoad(0, 1, "horizontal", "add");
    world.editRoad(1, 1, "horizontal", "add");
    world.editRoad(2, 1, "horizontal", "add");
    world.editZone(0, 0, "residential");
    world.placeService(2, 0, "power");

    const connectedHome = world
      .debugState()
      .buildings.find((building) => building.cellX === 0 && building.cellY === 0);
    expect(connectedHome?.powered).toBe(true);

    world.editRoad(1, 1, "horizontal", "remove");
    const disconnectedHome = world
      .debugState()
      .buildings.find((building) => building.cellX === 0 && building.cellY === 0);
    expect(disconnectedHome?.powered).toBe(false);
  });

  it("reports budget flow details in city stats", () => {
    const world = new SimWorld(10, 10, 123);
    world.editRoad(0, 1, "horizontal", "add");
    world.editRoad(1, 1, "horizontal", "add");
    world.editZone(0, 0, "residential");
    world.placeService(2, 0, "power");

    const stats = world.getSnapshot().cityStats;

    expect(stats.budgetIncome).toBeGreaterThan(0);
    expect(stats.roadsUpkeep).toBeGreaterThan(0);
    expect(stats.facilitiesUpkeep).toBeGreaterThan(0);
    expect(stats.budgetDelta).toBe(
      stats.budgetIncome - stats.roadsUpkeep - stats.facilitiesUpkeep
    );
  });

  it("tracks progression data in snapshots", () => {
    const world = new SimWorld(10, 10, 123);
    world.editRoad(0, 1, "horizontal", "add");
    world.editRoad(1, 1, "horizontal", "add");
    world.editRoad(2, 1, "horizontal", "add");
    world.editZone(0, 0, "residential");
    world.editZone(1, 0, "residential");
    world.placeService(2, 0, "power");

    for (let tick = 0; tick < 80; tick += 1) {
      world.tickOnce();
    }

    const snapshot = world.getSnapshot();
    expect(snapshot.progression.activeMilestoneId).toBeDefined();
    expect(snapshot.progression.activeMilestone).not.toBeNull();
    expect(snapshot.cityStats.tripCompletionRate).toBeGreaterThanOrEqual(0);
    expect(snapshot.cityStats.avgServiceReliability).toBeGreaterThanOrEqual(0);
  });

  it("unlocks denser zoning after the bootstrap milestone", () => {
    const world = new SimWorld(16, 16, 123);
    world.editRoad(0, 1, "horizontal", "add");
    world.editRoad(1, 1, "horizontal", "add");
    world.editRoad(2, 1, "horizontal", "add");
    world.editRoad(3, 1, "horizontal", "add");
    world.editRoad(4, 1, "horizontal", "add");
    world.editRoad(5, 1, "horizontal", "add");
    world.editRoad(6, 1, "horizontal", "add");
    world.placeService(6, 0, "power");
    world.editZone(0, 0, "residential");
    world.editZone(1, 0, "residential");
    world.editZone(2, 0, "residential");
    world.editZone(3, 0, "residential");
    world.editZone(4, 0, "residential");
    world.editZone(5, 0, "residential");

    for (let tick = 0; tick < 60; tick += 1) {
      world.tickOnce();
    }

    const snapshot = world.getSnapshot();
    expect(snapshot.progression.completedMilestoneIds).toContain("bootstrap-power");
    expect(snapshot.progression.unlocks.denserZones).toBe(true);
  });

  it("raises debt pressure when the budget stays negative", () => {
    const world = new SimWorld(12, 12, 123);
    world.placeService(0, 0, "power");
    world.placeService(3, 3, "power");
    world.placeService(6, 6, "power");
    world.setBudget(-3000);

    for (let tick = 0; tick < 120; tick += 1) {
      world.tickOnce();
    }

    expect(world.getSnapshot().cityStats.debtPressure).toBeGreaterThan(0);
  });

  it("interpolates visible vehicle positions between sim ticks", () => {
    const world = new SimWorld(8, 8, 123);
    world.editRoad(0, 1, "horizontal", "add");
    world.editRoad(1, 1, "horizontal", "add");
    world.editRoad(2, 1, "horizontal", "add");
    world.editZone(0, 0, "residential");
    world.editZone(2, 0, "commercial");

    const originId = buildingIdAt(world, 0, 0)!;
    const destinationId = buildingIdAt(world, 2, 0)!;
    const packet = world.debugCreateTrip(originId, destinationId, "commute", 1);
    expect(packet).not.toBeNull();

    world.tickOnce();

    const before = world.getSnapshot(0).vehicles[0];
    const after = world.getSnapshot(0.75).vehicles[0];

    expect(before).toBeDefined();
    expect(after).toBeDefined();
    expect(after.x).toBeGreaterThan(before.x);
  });

});
