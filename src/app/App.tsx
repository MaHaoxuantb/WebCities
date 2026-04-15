import React, { useCallback, useEffect, useRef, useState } from "react";

import {
  DEFAULT_OVERLAY,
  DEFAULT_TOOL,
  DEFAULT_TIME_SCALE,
  SAVE_SLOT_KEY,
  WORLD_HEIGHT,
  WORLD_WIDTH
} from "../shared/constants";
import { toWorkerMessage, type WorkerToMainMessage } from "../shared/messages";
import { parseSaveGame } from "../shared/save";
import type {
  NotificationMessage,
  OverlayKind,
  SimSnapshot,
  TimeScale,
  ToolMode
} from "../shared/types";
import { CityRenderer, type CanvasAction } from "../main/CityRenderer";
import {
  downloadSaveFile,
  hasIndexedDbSave,
  loadGameFromIndexedDb,
  readSaveFile,
  saveGameToIndexedDb
} from "../main/storage";

const buildTools: Array<{ id: ToolMode; label: string }> = [
  { id: "road", label: "Road" },
  { id: "junction-large", label: "Roundabout" },
  { id: "zone-residential", label: "Zone R" },
  { id: "zone-commercial", label: "Zone C" },
  { id: "zone-industrial", label: "Zone I" },
  { id: "service-power", label: "Power Plant" }
];

const overlays: Array<{ id: OverlayKind; title: string; detail: string }> = [
  {
    id: "traffic",
    title: "Traffic View",
    detail: "Shows road utilization and queue pressure."
  },
  {
    id: "power",
    title: "Power Grid",
    detail: "Shows which buildings are energized by road-connected power plants."
  },
  {
    id: "happiness",
    title: "Land Stress",
    detail: "Shows areas trending toward stability or abandonment."
  }
];

const timeScales: TimeScale[] = [0, 1, 2, 3];
const AUTOSAVE_DELAY_MS = 1500;

export const App = () => {
  const workerRef = useRef<Worker | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const pendingSaveDownloadRef = useRef(false);
  const pendingImportModeRef = useRef<"startup" | "manual" | null>(null);
  const autosaveTimeoutRef = useRef<number | null>(null);
  const [snapshot, setSnapshot] = useState<SimSnapshot | null>(null);
  const [overlay, setOverlay] = useState<OverlayKind>(DEFAULT_OVERLAY);
  const [tool, setTool] = useState<ToolMode>(DEFAULT_TOOL);
  const [notifications, setNotifications] = useState<NotificationMessage[]>([]);
  const [isExporting, setIsExporting] = useState(false);
  const [fileMenuOpen, setFileMenuOpen] = useState(false);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [startupChoiceOpen, setStartupChoiceOpen] = useState(true);
  const [hasAutosave, setHasAutosave] = useState<boolean | null>(null);

  useEffect(() => {
    const worker = new Worker(new URL("../worker/simWorker.ts", import.meta.url), {
      type: "module"
    });

    workerRef.current = worker;

    worker.onmessage = async (event: MessageEvent<WorkerToMainMessage>) => {
      const message = event.data;
      switch (message.type) {
        case "simSnapshot":
          setRuntimeError(null);
          setSnapshot(message.payload.snapshot);
          break;
        case "notification":
          setNotifications((current) => [message.payload, ...current.slice(0, 5)]);
          break;
        case "saveReady":
          await saveGameToIndexedDb(message.payload.saveGame, SAVE_SLOT_KEY);
          setHasAutosave(true);
          if (pendingSaveDownloadRef.current) {
            downloadSaveFile(message.payload.saveGame);
            pendingSaveDownloadRef.current = false;
            setNotifications((current) => [
              {
                id: Date.now(),
                level: "info",
                text: "Save file exported and autosave updated."
              },
              ...current.slice(0, 5)
            ]);
            setIsExporting(false);
          }
          break;
        default:
          break;
      }
    };

    worker.onerror = (event) => {
      setRuntimeError(event.message || "Worker failed to start.");
    };

    worker.onmessageerror = () => {
      setRuntimeError("Worker message deserialization failed.");
    };

    worker.postMessage(
      toWorkerMessage("initWorld", {
        width: WORLD_WIDTH,
        height: WORLD_HEIGHT,
        seed: 1337
      })
    );
    worker.postMessage(toWorkerMessage("setTimeScale", { timeScale: DEFAULT_TIME_SCALE }));
    worker.postMessage(toWorkerMessage("requestOverlay", { overlay: DEFAULT_OVERLAY }));

    void hasIndexedDbSave().then(setHasAutosave);

    return () => {
      worker.terminate();
      workerRef.current = null;
      if (autosaveTimeoutRef.current !== null) {
        window.clearTimeout(autosaveTimeoutRef.current);
      }
    };
  }, []);

  const send = useCallback(
    (message: Parameters<typeof toWorkerMessage>[0], payload: unknown) => {
      workerRef.current?.postMessage(
        toWorkerMessage(message as never, payload as never)
      );
    },
    []
  );

  useEffect(() => {
    if (!snapshot || startupChoiceOpen) {
      return;
    }

    if (autosaveTimeoutRef.current !== null) {
      return;
    }

    autosaveTimeoutRef.current = window.setTimeout(() => {
      autosaveTimeoutRef.current = null;
      send("saveGame", { slotKey: SAVE_SLOT_KEY });
    }, AUTOSAVE_DELAY_MS);

    return () => {
      if (startupChoiceOpen && autosaveTimeoutRef.current !== null) {
        window.clearTimeout(autosaveTimeoutRef.current);
        autosaveTimeoutRef.current = null;
      }
    };
  }, [snapshot, startupChoiceOpen, send]);

  const handleCanvasAction = useCallback(
    (action: CanvasAction) => {
      if (action.type === "road") {
        send("editRoad", action);
        return;
      }

      if (action.type === "junction") {
        send("placeLargeJunction", {
          centerCellX: action.centerCellX,
          centerCellY: action.centerCellY
        });
        return;
      }

      if (action.type === "bulldoze") {
        send("bulldozeAt", action);
        return;
      }

      if (action.type === "zone") {
        send("editZone", { x: action.x, y: action.y, zoneType: action.zoneType });
        return;
      }

      send("placeService", { x: action.x, y: action.y, kind: action.kind });
    },
    [send]
  );

  const handleOverlayChange = useCallback(
    (nextOverlay: OverlayKind) => {
      setOverlay(nextOverlay);
      send("requestOverlay", { overlay: nextOverlay });
    },
    [send]
  );

  const handleTimeScale = useCallback(
    (timeScale: TimeScale) => {
      send("setTimeScale", { timeScale });
    },
    [send]
  );

  const handleExport = useCallback(() => {
    pendingSaveDownloadRef.current = true;
    setIsExporting(true);
    setFileMenuOpen(false);
    send("saveGame", { slotKey: SAVE_SLOT_KEY });
  }, [send]);

  const handleImportClick = useCallback((mode: "startup" | "manual") => {
    pendingImportModeRef.current = mode;
    setFileMenuOpen(false);
    fileInputRef.current?.click();
  }, []);

  const handleNewCity = useCallback(() => {
    send("initWorld", {
      width: WORLD_WIDTH,
      height: WORLD_HEIGHT,
      seed: Date.now()
    });
    setStartupChoiceOpen(false);
    setNotifications((current) => [
      {
        id: Date.now(),
        level: "info",
        text: "Started a new city."
      },
      ...current.slice(0, 5)
    ]);
  }, [send]);

  const handleLoadAutosave = useCallback(async () => {
    const saveGame = await loadGameFromIndexedDb(SAVE_SLOT_KEY);
    if (!saveGame) {
      setHasAutosave(false);
      setNotifications((current) => [
        {
          id: Date.now(),
          level: "warning",
          text: "No autosave was found in IndexedDB."
        },
        ...current.slice(0, 5)
      ]);
      return;
    }

    send("loadGame", { saveGame });
    setStartupChoiceOpen(false);
    setNotifications((current) => [
      {
        id: Date.now(),
        level: "info",
        text: "Loaded the autosave from IndexedDB."
      },
      ...current.slice(0, 5)
    ]);
  }, [send]);

  const handleLoadFile = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file) {
        return;
      }

      try {
        const saveGame = parseSaveGame(await readSaveFile(file));
        send("loadGame", { saveGame });
        if (pendingImportModeRef.current === "startup") {
          setStartupChoiceOpen(false);
        }
        setNotifications((current) => [
          {
            id: Date.now(),
            level: "info",
            text: `Loaded ${file.name}.`
          },
          ...current.slice(0, 5)
        ]);
      } catch {
        setNotifications((current) => [
          {
            id: Date.now(),
            level: "error",
            text: "Could not read that save file."
          },
          ...current.slice(0, 5)
        ]);
      } finally {
        pendingImportModeRef.current = null;
        event.target.value = "";
      }
    },
    [send]
  );

  const activeOverlay = overlays.find((entry) => entry.id === overlay);
  const poweredRatio =
    snapshot && snapshot.cityStats.totalBuildings > 0
      ? `${snapshot.cityStats.poweredBuildings}/${snapshot.cityStats.totalBuildings}`
      : "0/0";
  const toolLabel =
    tool === "junction-large"
      ? "roundabout"
      : tool === "service-power"
        ? "power plant"
        : tool.replace("zone-", "");

  return (
    <div className="app-shell">
      <input
        accept=".json,.webcities.json,application/json"
        className="hidden-file-input"
        onChange={handleLoadFile}
        ref={fileInputRef}
        type="file"
      />

      <header className="topbar">
        <div className="brand-block">
          <p className="eyebrow">Annopia Relax</p>
          <h1>Web Cities (Preview)</h1>
        </div>

        <div className="toolbar-cluster">
          <span className="toolbar-label">Build</span>
          <div className="toolbar-strip">
            {buildTools.map((entry) => (
              <button
                key={entry.id}
                className={tool === entry.id ? "is-active" : ""}
                onClick={() => setTool(entry.id)}
                type="button"
              >
                {entry.label}
              </button>
            ))}
          </div>
        </div>

        <div className="toolbar-cluster compact-strip">
          <span className="toolbar-label">Sim</span>
          <div className="toolbar-strip">
            {timeScales.map((entry) => (
              <button
                key={entry}
                className={snapshot?.timeScale === entry ? "is-active" : ""}
                onClick={() => handleTimeScale(entry)}
                type="button"
              >
                {entry === 0 ? "Pause" : `${entry}x`}
              </button>
            ))}
          </div>
        </div>

        <div className="toolbar-cluster compact-strip">
          <span className="toolbar-label">File</span>
          <div className="toolbar-menu">
            <button
              className={fileMenuOpen ? "is-active" : ""}
              onClick={() => setFileMenuOpen((current) => !current)}
              type="button"
            >
              File
            </button>
            {fileMenuOpen ? (
              <div className="toolbar-dropdown">
                <button onClick={handleExport} type="button">
                  {isExporting ? "Exporting..." : "Export Save File"}
                </button>
                <button onClick={() => handleImportClick("manual")} type="button">
                  Import Save File
                </button>
                <div className="dropdown-note">
                  Autosave is kept in IndexedDB as a single city slot.
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </header>

      <div className="workspace">
        <aside className="left-panel">
          <section className="panel-section">
            <h2>Construction</h2>
            <p className="lede">
              Left click uses the active tool. Right click bulldozes whatever is under
              the cursor without leaving build mode. Roads snap directly to cell edges.
            </p>
          </section>

          <section className="panel-section">
            <h2>Views</h2>
            <div className="stacked-grid">
              {overlays.map((entry) => (
                <button
                  key={entry.id}
                  className={overlay === entry.id ? "is-active" : ""}
                  onClick={() => handleOverlayChange(entry.id)}
                  type="button"
                >
                  {entry.title}
                </button>
              ))}
            </div>
            <p className="panel-note">{activeOverlay?.detail}</p>
          </section>

          <section className="panel-section">
            <h2>Controls</h2>
            <p className="hint">
              Two-finger scroll pans. Pinch or modifier-wheel zooms. Middle mouse,
              <code>Alt</code>, or holding space also enters pan mode.
            </p>
          </section>

          <section className="panel-section">
            <h2>Power</h2>
            <p className="hint">
              Power plants energize buildings only when the building can reach a plant
              through the road network. Outages still require maintenance crews to get
              through traffic.
            </p>
          </section>
        </aside>

        <main className="viewport">
          <div className="viewport-header">
            <div className="viewport-chip">
              Overlay <strong>{activeOverlay?.title ?? overlay}</strong>
            </div>
            <div className="viewport-chip">
              Active tool <strong>{toolLabel}</strong>
            </div>
            <div className="viewport-chip">
              Power <strong>{poweredRatio}</strong>
            </div>
          </div>

          <CityRenderer
            snapshot={snapshot}
            overlay={overlay}
            tool={tool}
            onAction={handleCanvasAction}
          />

          {!snapshot || runtimeError ? (
            <div className="viewport-status">
              <div className="status-card">
                <h2>{runtimeError ? "Runtime Error" : "Booting Simulation"}</h2>
                <p>
                  {runtimeError
                    ? runtimeError
                    : "Waiting for the worker to deliver the first city snapshot."}
                </p>
              </div>
            </div>
          ) : null}

          {startupChoiceOpen ? (
            <div className="startup-overlay">
              <div className="startup-card">
                <h2>Choose A City Source</h2>
                <p>
                  Pick how to start this session. The game keeps a single autosave in
                  IndexedDB and also supports importing or exporting local save files.
                </p>
                <div className="startup-actions">
                  <button
                    disabled={!hasAutosave}
                    onClick={() => void handleLoadAutosave()}
                    type="button"
                  >
                    {hasAutosave ? "Continue Autosave" : "No Autosave Found"}
                  </button>
                  <button onClick={() => handleImportClick("startup")} type="button">
                    Import Save File
                  </button>
                  <button onClick={handleNewCity} type="button">
                    Create New City
                  </button>
                </div>
              </div>
            </div>
          ) : null}
        </main>

        <aside className="right-panel">
          <section className="panel-section">
            <h2>City State</h2>
            <div className="stat-grid">
              <Stat label="Tick" value={snapshot?.cityStats.tick ?? 0} />
              <Stat label="Pop" value={snapshot?.cityStats.population ?? 0} />
              <Stat label="Jobs" value={snapshot?.cityStats.jobs ?? 0} />
              <Stat label="Trips" value={snapshot?.cityStats.activeTrips ?? 0} />
              <Stat label="Queued" value={snapshot?.cityStats.queuedTrips ?? 0} />
              <Stat label="Budget" value={Math.round(snapshot?.cityStats.budget ?? 0)} />
              <Stat label="Outages" value={snapshot?.cityStats.outages ?? 0} />
              <Stat label="Plants" value={snapshot?.cityStats.powerPlants ?? 0} />
              <Stat label="Powered" value={snapshot?.cityStats.poweredBuildings ?? 0} />
              <Stat label="Tick ms" value={snapshot?.perfStats.tickMs ?? 0} />
            </div>
          </section>

          <section className="panel-section">
            <h2>Demand</h2>
            <DemandBar
              label="Residential"
              value={snapshot?.cityStats.demandResidential ?? 0}
            />
            <DemandBar
              label="Commercial"
              value={snapshot?.cityStats.demandCommercial ?? 0}
            />
            <DemandBar
              label="Industrial"
              value={snapshot?.cityStats.demandIndustrial ?? 0}
            />
          </section>

          <section className="panel-section">
            <h2>Event Feed</h2>
            <div className="notifications">
              {notifications.length > 0 ? (
                notifications.map((notification) => (
                  <div
                    className={`notification ${notification.level}`}
                    key={notification.id}
                  >
                    {notification.text}
                  </div>
                ))
              ) : (
                <div className="notification neutral">
                  No events yet. Build a connected road network, add zoning, and place
                  a power plant to energize development.
                </div>
              )}
            </div>
          </section>
        </aside>
      </div>
    </div>
  );
};

const Stat = ({ label, value }: { label: string; value: number }) => (
  <div className="stat-card">
    <span>{label}</span>
    <strong>{Number.isFinite(value) ? value : 0}</strong>
  </div>
);

const DemandBar = ({ label, value }: { label: string; value: number }) => (
  <div className="demand-row">
    <span>{label}</span>
    <div className="demand-track">
      <div className="demand-fill" style={{ width: `${value}%` }} />
    </div>
    <strong>{Math.round(value)}</strong>
  </div>
);
