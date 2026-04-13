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
});
