import { z } from "zod";

import type { ProgressionState, ReplayCommand } from "./types";

const roadSegmentSchema = z.object({
  key: z.string(),
  x: z.number(),
  y: z.number(),
  orientation: z.union([z.literal("horizontal"), z.literal("vertical")]),
  direction: z
    .union([z.literal("both"), z.literal("forward"), z.literal("reverse")])
    .default("both"),
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
  outageTicksRemaining: z.number(),
  serviceReliability: z.number(),
  throughputScore: z.number(),
  productivity: z.number(),
  recentOutageTicks: z.number()
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

const unlockStateSchema = z.object({
  arterialRoads: z.boolean(),
  denserZones: z.boolean(),
  advancedPowerPlants: z.boolean(),
  occupancyCapBonus: z.number()
});

const milestoneConstraintProgressSchema = z.object({
  label: z.string(),
  current: z.number(),
  target: z.number(),
  comparator: z.union([z.literal("gte"), z.literal("lte")]),
  complete: z.boolean()
});

const milestoneProgressSchema = z.object({
  id: z.union([
    z.literal("bootstrap-power"),
    z.literal("town-growth"),
    z.literal("logistics-flow"),
    z.literal("resilience-run")
  ]),
  stage: z.union([
    z.literal("bootstrap"),
    z.literal("town"),
    z.literal("logistics"),
    z.literal("resilience")
  ]),
  title: z.string(),
  summary: z.string(),
  rewardText: z.string(),
  primary: milestoneConstraintProgressSchema,
  secondary: z.array(milestoneConstraintProgressSchema),
  blockers: z.array(z.string()),
  complete: z.boolean()
});

const progressionStateSchema = z.object({
  currentStage: z.union([
    z.literal("bootstrap"),
    z.literal("town"),
    z.literal("logistics"),
    z.literal("resilience")
  ]),
  threatLevel: z.number(),
  pressureTier: z.number(),
  activeMilestoneId: z
    .union([
      z.literal("bootstrap-power"),
      z.literal("town-growth"),
      z.literal("logistics-flow"),
      z.literal("resilience-run")
    ])
    .nullable(),
  completedMilestoneIds: z.array(
    z.union([
      z.literal("bootstrap-power"),
      z.literal("town-growth"),
      z.literal("logistics-flow"),
      z.literal("resilience-run")
    ])
  ),
  rewardLog: z.array(z.string()),
  unlocks: unlockStateSchema,
  activeMilestone: milestoneProgressSchema.nullable(),
  score: z.number(),
  cityGrade: z.string()
}) satisfies z.ZodType<ProgressionState>;

const replayCommandSchema = z.object({
  tick: z.number(),
  command: z.union([
    z.literal("editRoad"),
    z.literal("editZone"),
    z.literal("bulldozeAt"),
    z.literal("placeBuilding"),
    z.literal("placeService"),
    z.literal("setBudget"),
    z.literal("setTimeScale")
  ]),
  payload: z.unknown()
}) satisfies z.ZodType<ReplayCommand>;

export const saveGameV2Schema = z.object({
  version: z.literal(2),
  width: z.number(),
  height: z.number(),
  tick: z.number(),
  seed: z.number(),
  budget: z.number(),
  timeScale: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
  overlay: z.union([
    z.literal("none"),
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
  replayLog: z.array(replayCommandSchema),
  progression: progressionStateSchema,
  positiveBudgetStreak: z.number(),
  longestPositiveBudgetStreak: z.number(),
  tripAttemptsWindow: z.number(),
  tripCompletionsWindow: z.number(),
  tripFailuresWindow: z.number()
});

export type SaveGameV2 = z.infer<typeof saveGameV2Schema>;

export const parseSaveGame = (input: unknown): SaveGameV2 =>
  saveGameV2Schema.parse(input);
