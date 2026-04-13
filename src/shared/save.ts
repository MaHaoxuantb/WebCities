import { z } from "zod";

import type { ReplayCommand } from "./types";

const roadSegmentSchema = z.object({
  key: z.string(),
  x: z.number(),
  y: z.number(),
  orientation: z.union([z.literal("horizontal"), z.literal("vertical")]),
  lanes: z.number(),
  speedLimit: z.number()
});

const zoneSchema = z.object({
  cellKey: z.string(),
  x: z.number(),
  y: z.number(),
  zoneType: z.union([
    z.literal("residential"),
    z.literal("commercial"),
    z.literal("industrial")
  ])
});

const buildingSchema = z.object({
  id: z.number(),
  cellX: z.number(),
  cellY: z.number(),
  kind: z.union([
    z.literal("residential"),
    z.literal("commercial"),
    z.literal("industrial"),
    z.literal("powerPlant")
  ]),
  occupancy: z.number(),
  jobs: z.number(),
  powered: z.boolean(),
  happiness: z.number(),
  abandoned: z.boolean(),
  accessNodeIds: z.array(z.number()),
  outageTicksRemaining: z.number()
});

const facilitySchema = z.object({
  id: z.number(),
  buildingId: z.number(),
  kind: z.literal("power"),
  crewCapacity: z.number(),
  activeJobIds: z.array(z.number())
});

const tripPacketSchema = z.object({
  id: z.number(),
  purpose: z.union([
    z.literal("commute"),
    z.literal("commercial"),
    z.literal("cargo"),
    z.literal("service")
  ]),
  quantity: z.number(),
  routeEdgeIds: z.array(z.number()),
  currentLeg: z.number(),
  currentNodeId: z.number(),
  currentEdgeId: z.number().nullable(),
  edgeTicksRemaining: z.number(),
  edgeTicksTotal: z.number(),
  originBuildingId: z.number(),
  destinationBuildingId: z.number(),
  state: z.union([
    z.literal("queued"),
    z.literal("moving"),
    z.literal("complete"),
    z.literal("failed")
  ]),
  colorHint: z.number(),
  serviceJobId: z.number().optional()
});

const powerJobSchema = z.object({
  id: z.number(),
  buildingId: z.number(),
  assignedPacketId: z.number().nullable(),
  createdTick: z.number(),
  state: z.union([
    z.literal("pending"),
    z.literal("assigned"),
    z.literal("resolved")
  ])
});

const replayCommandSchema: z.ZodType<ReplayCommand> = z.object({
  tick: z.number(),
  command: z.union([
    z.literal("editRoad"),
    z.literal("editZone"),
    z.literal("placeBuilding"),
    z.literal("placeService"),
    z.literal("setBudget"),
    z.literal("setTimeScale")
  ]),
  payload: z.unknown()
});

export const saveGameV1Schema = z.object({
  version: z.literal(1),
  width: z.number(),
  height: z.number(),
  tick: z.number(),
  seed: z.number(),
  budget: z.number(),
  timeScale: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
  overlay: z.union([
    z.literal("traffic"),
    z.literal("power"),
    z.literal("happiness")
  ]),
  nextIds: z.object({
    buildingId: z.number(),
    facilityId: z.number(),
    tripId: z.number(),
    powerJobId: z.number(),
    notificationId: z.number()
  }),
  roads: z.array(roadSegmentSchema),
  zones: z.array(zoneSchema),
  buildings: z.array(buildingSchema),
  serviceFacilities: z.array(facilitySchema),
  activeTrips: z.array(tripPacketSchema),
  powerJobs: z.array(powerJobSchema),
  replayLog: z.array(replayCommandSchema)
});

export type SaveGameV1 = z.infer<typeof saveGameV1Schema>;

export const parseSaveGame = (input: unknown): SaveGameV1 =>
  saveGameV1Schema.parse(input);
