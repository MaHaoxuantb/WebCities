/// <reference lib="webworker" />

import type { MainToWorkerMessage } from "../shared/messages";
import { toMainMessage } from "../shared/messages";
import {
  SAVE_SLOT_KEY,
  SIM_PRESENTATION_INTERVAL_MS,
  SIM_TICK_MS,
  WORLD_HEIGHT,
  WORLD_WIDTH
} from "../shared/constants";
import { SimWorld } from "./world";

let world = new SimWorld(WORLD_WIDTH, WORLD_HEIGHT, 1337);
let accumulator = 0;
let lastFrameTime = performance.now();
let lastPostedTick = -1;
let snapshotDirty = true;

const getSimulationAlpha = () =>
  world.timeScale > 0 ? Math.min(0.999, accumulator / SIM_TICK_MS) : 0;

const postSnapshot = (simulationAlpha = getSimulationAlpha()) => {
  const snapshot = world.getSnapshot(simulationAlpha);
  self.postMessage(toMainMessage("simSnapshot", { snapshot }));

  for (const notification of world.consumeNotifications()) {
    self.postMessage(toMainMessage("notification", notification));
  }

  lastPostedTick = snapshot.tick;
  snapshotDirty = false;
};

const runLoop = () => {
  const now = performance.now();
  const delta = now - lastFrameTime;
  lastFrameTime = now;

  let advanced = false;
  if (world.timeScale > 0) {
    accumulator += delta * world.timeScale;
    while (accumulator >= SIM_TICK_MS) {
      world.tickOnce();
      accumulator -= SIM_TICK_MS;
      advanced = true;
    }
  }

  if (advanced || snapshotDirty || world.tick !== lastPostedTick || world.timeScale > 0) {
    postSnapshot();
  }
};

self.setInterval(runLoop, SIM_PRESENTATION_INTERVAL_MS);

self.onmessage = (event: MessageEvent<MainToWorkerMessage>) => {
  const message = event.data;
  switch (message.type) {
    case "initWorld":
      world = new SimWorld(
        message.payload.width,
        message.payload.height,
        message.payload.seed
      );
      accumulator = 0;
      lastFrameTime = performance.now();
      snapshotDirty = true;
      postSnapshot(0);
      break;
    case "editRoad":
      world.editRoad(
        message.payload.x,
        message.payload.y,
        message.payload.orientation,
        message.payload.mode
      );
      snapshotDirty = true;
      postSnapshot();
      break;
    case "editZone":
      world.editZone(
        message.payload.x,
        message.payload.y,
        message.payload.zoneType
      );
      snapshotDirty = true;
      postSnapshot();
      break;
    case "bulldozeAt":
      world.bulldozeAt(
        message.payload.cellX,
        message.payload.cellY,
        message.payload.road ?? null
      );
      snapshotDirty = true;
      postSnapshot();
      break;
    case "placeBuilding":
      world.placeBuilding(
        message.payload.x,
        message.payload.y,
        message.payload.building
      );
      snapshotDirty = true;
      postSnapshot();
      break;
    case "placeService":
      world.placeService(
        message.payload.x,
        message.payload.y,
        message.payload.kind
      );
      snapshotDirty = true;
      postSnapshot();
      break;
    case "setBudget":
      world.setBudget(message.payload.delta);
      snapshotDirty = true;
      postSnapshot();
      break;
    case "setTimeScale":
      world.setTimeScale(message.payload.timeScale);
      snapshotDirty = true;
      postSnapshot();
      break;
    case "requestOverlay":
      world.setOverlay(message.payload.overlay);
      snapshotDirty = true;
      postSnapshot();
      break;
    case "saveGame":
      self.postMessage(
        toMainMessage("saveReady", {
          slotKey: message.payload.slotKey || SAVE_SLOT_KEY,
          saveGame: world.serialize()
        })
      );
      break;
    case "loadGame":
      world = SimWorld.fromSave(message.payload.saveGame);
      accumulator = 0;
      lastFrameTime = performance.now();
      snapshotDirty = true;
      postSnapshot(0);
      break;
    case "requestSnapshot":
      snapshotDirty = true;
      postSnapshot();
      break;
    default:
      break;
  }
};
