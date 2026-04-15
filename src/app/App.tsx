import React, { startTransition, useCallback, useEffect, useRef, useState } from "react";

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
    detail: "Shows road utilization, queue pressure, and where service trips will bog down."
  },
  {
    id: "power",
    title: "Power Grid",
    detail: "Shows which buildings are energized through the current road-connected power network."
  },
  {
    id: "happiness",
    title: "Land Stress",
    detail: "Shows where outages or missing access are pushing buildings toward abandonment."
  }
];

const systemDocs: Array<{
  title: string;
  summary: string;
  body: string[];
}> = [
  {
    title: "Road Network",
    summary: "Roads define every trip, queue, service response, and power path.",
    body: [
      "Roads snap to cell edges and become the graph that commuters, cargo, and maintenance crews use.",
      "Roundabouts replace a four-way intersection with a one-way loop, which usually reduces queue buildup.",
      "Traffic pressure is about both speed and storage. A road can become blocked when the next edge has no room for another packet."
    ]
  },
  {
    title: "Zoning",
    summary: "Residential creates population, while commercial and industrial create job demand.",
    body: [
      "Residential buildings grow occupancy when they have road access, power, and enough happiness.",
      "Commercial and industrial buildings provide jobs only when they can connect to the road graph.",
      "Buildings trend toward abandonment when they stay disconnected, unpowered, or repeatedly delayed."
    ]
  },
  {
    title: "Power And Crews",
    summary: "Power and maintenance both depend on the same reachable road network.",
    body: [
      "A building is powered only when at least one of its access nodes can reach a power plant.",
      "Power outages spawn over time on active buildings and remain until a maintenance crew reaches the site.",
      "Each power plant provides two crews, so plants improve both coverage and outage recovery capacity."
    ]
  },
  {
    title: "Demand And Budget",
    summary: "Budget and growth are driven by occupied homes and the cost of keeping infrastructure online.",
    body: [
      "The budget updates every twenty ticks from residential income minus road upkeep and power facility upkeep.",
      "Residential demand rises when jobs outpace population. Commercial and industrial demand react to the current mix of homes and employment.",
      "If infrastructure grows faster than occupancy, the budget cycle turns negative until more homes fill in."
    ]
  },
  {
    title: "Overlays And Saves",
    summary: "Use overlays to diagnose the current bottleneck and saves to preserve a city state.",
    body: [
      "Traffic view explains congestion, power view shows energized coverage, and land stress reveals happiness pressure.",
      "The sim keeps one IndexedDB autosave slot and also supports importing or exporting local JSON save files.",
      "Starting a new city resets the simulation seed while leaving the current UI controls and save workflow intact."
    ]
  }
];

const timeScales: TimeScale[] = [0, 1, 2, 3];
const AUTOSAVE_DELAY_MS = 1500;
const MAX_NOTIFICATIONS = 6;

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
          startTransition(() => {
            setSnapshot(message.payload.snapshot);
          });
          break;
        case "notification":
          setNotifications((current) => [
            message.payload,
            ...current.slice(0, MAX_NOTIFICATIONS - 1)
          ]);
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
              ...current.slice(0, MAX_NOTIFICATIONS - 1)
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
      ...current.slice(0, MAX_NOTIFICATIONS - 1)
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
        ...current.slice(0, MAX_NOTIFICATIONS - 1)
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
      ...current.slice(0, MAX_NOTIFICATIONS - 1)
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
          ...current.slice(0, MAX_NOTIFICATIONS - 1)
        ]);
      } catch {
        setNotifications((current) => [
          {
            id: Date.now(),
            level: "error",
            text: "Could not read that save file."
          },
          ...current.slice(0, MAX_NOTIFICATIONS - 1)
        ]);
      } finally {
        pendingImportModeRef.current = null;
        event.target.value = "";
      }
    },
    [send]
  );

  const activeOverlay = overlays.find((entry) => entry.id === overlay);
  const stats = snapshot?.cityStats ?? null;
  const budgetDelta = stats?.budgetDelta ?? 0;
  const budgetDeltaLabel =
    budgetDelta >= 0 ? `+${budgetDelta.toFixed(1)}` : budgetDelta.toFixed(1);
  const poweredRatio =
    stats && stats.totalBuildings > 0
      ? `${stats.poweredBuildings}/${stats.totalBuildings}`
      : "0/0";
  const toolLabel =
    tool === "junction-large"
      ? "roundabout"
      : tool === "service-power"
        ? "power plant"
        : tool.replace("zone-", "");
  const quickTips = [
    tool === "road"
      ? "Lay down a connected road spine before zoning so new buildings instantly inherit access."
      : tool === "junction-large"
        ? "Roundabouts work best where four approach roads meet and queues are stacking at one node."
        : tool === "service-power"
          ? "A power plant adds coverage and two crews, but each plant also increases ongoing upkeep."
          : "Zone adjacent to connected roads so the building can join the network as soon as it spawns.",
    stats && stats.poweredBuildings < stats.totalBuildings
      ? "Some buildings are dark. Extend the road network toward the outage or add another plant closer to demand."
      : "Powered buildings still rely on traffic flow because freight and maintenance crews travel on the same roads as commuters.",
    budgetDelta < 0
      ? "Your current budget cycle is negative. More occupied homes or less infrastructure will stabilize the city."
      : "The current budget cycle is positive, which means occupied homes are covering your road and facility upkeep."
  ];

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
            <h2>Quick Tips</h2>
            <div className="tip-list">
              {quickTips.map((tip) => (
                <div className="tip-card" key={tip}>
                  {tip}
                </div>
              ))}
            </div>
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
            <h2>Systems Guide</h2>
            <div className="doc-list">
              {systemDocs.map((entry) => (
                <details className="doc-card" key={entry.title}>
                  <summary>
                    <span>{entry.title}</span>
                    <small>{entry.summary}</small>
                  </summary>
                  <div className="doc-body">
                    {entry.body.map((paragraph) => (
                      <p key={paragraph}>{paragraph}</p>
                    ))}
                  </div>
                </details>
              ))}
            </div>
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
            <div className={`viewport-chip ${budgetDelta >= 0 ? "positive" : "negative"}`}>
              Budget Flow <strong>{budgetDeltaLabel}</strong>
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
              <Stat label="Tick" value={stats?.tick ?? 0} />
              <Stat label="Pop" value={stats?.population ?? 0} />
              <Stat label="Jobs" value={stats?.jobs ?? 0} />
              <Stat label="Trips" value={stats?.activeTrips ?? 0} />
              <Stat label="Queued" value={stats?.queuedTrips ?? 0} />
              <Stat label="Budget" value={Math.round(stats?.budget ?? 0)} />
              <Stat label="Outages" value={stats?.outages ?? 0} />
              <Stat label="Plants" value={stats?.powerPlants ?? 0} />
              <Stat label="Powered" value={stats?.poweredBuildings ?? 0} />
              <Stat label="Tick ms" value={snapshot?.perfStats.tickMs ?? 0} />
            </div>
          </section>

          <section className="panel-section">
            <h2>Demand</h2>
            <DemandBar label="Residential" value={stats?.demandResidential ?? 0} />
            <DemandBar label="Commercial" value={stats?.demandCommercial ?? 0} />
            <DemandBar label="Industrial" value={stats?.demandIndustrial ?? 0} />
          </section>

          <section className="panel-section">
            <h2>Budget Flow</h2>
            <div className="budget-grid">
              <Stat label="Income" value={stats?.budgetIncome ?? 0} />
              <Stat label="Road Upkeep" value={stats?.roadsUpkeep ?? 0} />
              <Stat label="Facility Upkeep" value={stats?.facilitiesUpkeep ?? 0} />
              <Stat label="Net / Cycle" value={stats?.budgetDelta ?? 0} />
            </div>
            <p className="panel-note">
              Budget updates every 20 ticks. Income comes from occupied residential
              buildings, while each road segment and power facility adds upkeep.
            </p>
            <div className="ledger">
              <div className="ledger-row">
                <span>Occupied homes</span>
                <strong>
                  {stats
                    ? `${Math.round(stats.population)} pop funding ${stats.budgetIncome.toFixed(1)}`
                    : "0 pop funding 0.0"}
                </strong>
              </div>
              <div className="ledger-row">
                <span>Infrastructure load</span>
                <strong>
                  {stats
                    ? `${stats.roadsUpkeep.toFixed(1)} roads + ${stats.facilitiesUpkeep.toFixed(1)} facilities`
                    : "0.0 roads + 0.0 facilities"}
                </strong>
              </div>
            </div>
          </section>

          <section className="panel-section">
            <h2>Feature Notes</h2>
            <div className="doc-body compact">
              <p>
                Trips originate from homes toward jobs and commercial leisure, while
                industrial buildings also create cargo trips toward commercial targets.
              </p>
              <p>
                The traffic overlay reflects utilization and queueing on each road edge,
                so a road can look stressed even before it becomes fully blocked.
              </p>
              <p>
                Happiness recovers when buildings regain power and access, which means
                a cleaner road network improves both traffic and land stability.
              </p>
            </div>
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
    <strong>{Number.isFinite(value) ? value.toFixed(value % 1 === 0 ? 0 : 1) : 0}</strong>
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
