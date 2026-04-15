import { describe, expect, it } from "vitest";

import { SimWorld } from "../src/worker/world";
import { findBestRoute } from "../src/worker/pathfinding";

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
      version: 1,
      roads: save.roads,
      zones: save.zones
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

  it("places a roundabout ring around the four cells adjacent to an intersection", () => {
    const world = new SimWorld(12, 12, 123);
    world.placeLargeJunction(4, 4);
    const roads = world.getSnapshot().roads;
    expect(roads).toHaveLength(8);
    expect(
      roads.some(
        (road) => road.x === 3 && road.y === 3 && road.orientation === "horizontal"
      )
    ).toBe(true);
    expect(
      roads.some(
        (road) => road.x === 4 && road.y === 3 && road.orientation === "horizontal"
      )
    ).toBe(true);
    expect(
      roads.some(
        (road) => road.x === 3 && road.y === 5 && road.orientation === "horizontal"
      )
    ).toBe(true);
    expect(
      roads.some(
        (road) => road.x === 5 && road.y === 4 && road.orientation === "vertical"
      )
    ).toBe(true);

    const blocked = new SimWorld(12, 12, 123);
    blocked.editZone(3, 3, "residential");
    blocked.placeLargeJunction(4, 4);
    expect(blocked.getSnapshot().roads).toHaveLength(0);
  });

  it("routes traffic around the roundabout in one direction", () => {
    const world = new SimWorld(12, 12, 123);
    world.placeLargeJunction(4, 4);

    const topNode = world.nodes.find((node) => node.x === 4 && node.y === 3);
    const rightNode = world.nodes.find((node) => node.x === 5 && node.y === 4);
    expect(topNode).toBeDefined();
    expect(rightNode).toBeDefined();

    const clockwise = findBestRoute(
      world,
      [topNode!.id],
      [rightNode!.id],
      new Map()
    );
    const reverse = findBestRoute(
      world,
      [rightNode!.id],
      [topNode!.id],
      new Map()
    );

    expect(clockwise).not.toBeNull();
    expect(reverse).not.toBeNull();
    expect(clockwise!.edgeIds.length).toBe(2);
    expect(reverse!.edgeIds.length).toBeGreaterThan(clockwise!.edgeIds.length);
  });
});
