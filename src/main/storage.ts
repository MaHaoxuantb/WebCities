import { openDB } from "idb";

import { SAVE_SLOT_KEY } from "../shared/constants";
import { parseSaveGame, type SaveGameV2 } from "../shared/save";

const FILE_EXTENSION = ".webcities.json";
const DB_NAME = "webcities";
const STORE_NAME = "saves";

const getDb = () =>
  openDB(DB_NAME, 1, {
    upgrade(db) {
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    }
  });

export const saveGameToIndexedDb = async (
  saveGame: SaveGameV2,
  slotKey = SAVE_SLOT_KEY
) => {
  const db = await getDb();
  await db.put(STORE_NAME, saveGame, slotKey);
};

export const loadGameFromIndexedDb = async (slotKey = SAVE_SLOT_KEY) => {
  const db = await getDb();
  const save = await db.get(STORE_NAME, slotKey);
  if (!save) {
    return null;
  }

  return parseSaveGame(save);
};

export const hasIndexedDbSave = async (slotKey = SAVE_SLOT_KEY) => {
  const db = await getDb();
  const save = await db.getKey(STORE_NAME, slotKey);
  return save !== undefined;
};

export const downloadSaveFile = (saveGame: SaveGameV2) => {
  const json = JSON.stringify(saveGame, null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  link.href = url;
  link.download = `webcities-${timestamp}${FILE_EXTENSION}`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
};

export const readSaveFile = async (file: File) => {
  const text = await file.text();
  const parsed = JSON.parse(text) as unknown;
  return parseSaveGame(parsed);
};
