import { openDB } from "idb";

import { SAVE_SLOT_KEY } from "../shared/constants";
import { parseSaveGame, type SaveGameV1 } from "../shared/save";

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
  saveGame: SaveGameV1,
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
