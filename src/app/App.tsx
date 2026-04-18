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
  MilestoneConstraintProgress,
  NotificationMessage,
  OverlayKind,
  ProgressionState,
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

const buildTools: Array<{ id: ToolMode; label: string; upgradedLabel: string }> = [
  { id: "road", label: "Road", upgradedLabel: "Arterial" },
  { id: "zone-residential", label: "Zone R", upgradedLabel: "Zone R+" },
  { id: "zone-commercial", label: "Zone C", upgradedLabel: "Zone C+" },
  { id: "zone-industrial", label: "Zone I", upgradedLabel: "Zone I+" },
  { id: "service-power", label: "Power Plant", upgradedLabel: "Grid Hub" }
];

const overlays: Array<{ id: OverlayKind; title: string; detail: string }> = [
  {
    id: "none",
    title: "Overview",
    detail: "Keep the full city visible without a problem focus applied."
  },
  {
    id: "traffic",
    title: "Traffic Focus",
    detail: "Dim the city and spotlight the roads, queues, and junctions that are actually under stress."
  },
  {
    id: "power",
    title: "Power Focus",
    detail: "Dim the canvas and highlight the buildings that are still dark or waiting on the network."
  },
  {
    id: "happiness",
    title: "Land Stress Focus",
    detail: "Dim the city and highlight the buildings with the worst land stress or abandonment risk."
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
      "Traffic pressure is about both speed and storage. A road can become blocked when the next edge has no room for another packet.",
      "Busy intersections still matter because multiple movements share the same nodes and can stack queues there."
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
    title: "Focus And Saves",
    summary: "Use focus modes to diagnose the current bottleneck and saves to preserve a city state.",
    body: [
      "Traffic focus isolates congestion, power focus isolates outages, and land stress focus isolates the buildings under the most pressure.",
      "The sim keeps one IndexedDB autosave slot and also supports importing or exporting local JSON save files.",
      "Starting a new city resets the simulation seed while leaving the current UI controls and save workflow intact."
    ]
  }
];

const timeScales: TimeScale[] = [0, 1, 2, 3];
const AUTOSAVE_DELAY_MS = 1500;
const MAX_NOTIFICATIONS = 6;
type SystemTheme = "dark" | "light";

const getPreferredTheme = (): SystemTheme =>
  window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";

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
  const [systemTheme, setSystemTheme] = useState<SystemTheme>(() => getPreferredTheme());

  useEffect(() => {
    const mediaQuery = window.matchMedia("(prefers-color-scheme: light)");
    const handleChange = () => {
      setSystemTheme(mediaQuery.matches ? "light" : "dark");
    };

    handleChange();
    mediaQuery.addEventListener("change", handleChange);

    return () => {
      mediaQuery.removeEventListener("change", handleChange);
    };
  }, []);

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
      const targetOverlay = overlay === nextOverlay ? "none" : nextOverlay;
      setOverlay(targetOverlay);
      send("requestOverlay", { overlay: targetOverlay });
    },
    [overlay, send]
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
  const progression = snapshot?.progression ?? null;
  const budgetDelta = stats?.budgetDelta ?? 0;
  const budgetDeltaLabel =
    budgetDelta >= 0 ? `+${budgetDelta.toFixed(1)}` : budgetDelta.toFixed(1);
  const poweredRatio =
    stats && stats.totalBuildings > 0
      ? `${stats.poweredBuildings}/${stats.totalBuildings}`
      : "0/0";
  const toolLabel =
    tool === "service-power"
        ? "power plant"
        : tool.replace("zone-", "");
  const activeMilestone = progression?.activeMilestone ?? null;
  const blockers =
    activeMilestone?.blockers.length
      ? activeMilestone.blockers
      : [
          stats && stats.poweredBuildings < stats.totalBuildings
            ? "Power coverage is still incomplete."
            : budgetDelta < 0
              ? "Budget flow is negative."
              : "The city is stable enough to push the next milestone."
        ];
  const buildButtons = buildTools.map((entry) => ({
    ...entry,
    label:
      (entry.id === "road" && progression?.unlocks.arterialRoads) ||
      (entry.id !== "road" &&
        entry.id !== "service-power" &&
        progression?.unlocks.denserZones) ||
      (entry.id === "service-power" && progression?.unlocks.advancedPowerPlants)
        ? entry.upgradedLabel
        : entry.label
  }));
  const objectiveSummary = activeMilestone?.summary
    ?? "Grow a stable city by maintaining power, traffic flow, and positive cash flow.";
  const overlayInsight =
    activeMilestone?.blockers[0]
      ? `${activeOverlay?.detail} Current blocker: ${activeMilestone.blockers[0]}.`
      : activeOverlay?.detail;
  const viewportClassName = overlay !== "none" ? "viewport overlay-active" : "viewport";

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
            {buildButtons.map((entry) => (
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
            <h2>Current Objective</h2>
            <p className="lede">{objectiveSummary}</p>
            {activeMilestone ? (
              <div className="doc-body compact">
                <p>
                  <strong>{activeMilestone.title}</strong>
                  {` `}
                  rewards {activeMilestone.rewardText.toLowerCase()}
                </p>
                <ProgressMetric
                  progress={activeMilestone.primary}
                  emphasize
                />
                {activeMilestone.secondary.map((constraint) => (
                  <ProgressMetric key={constraint.label} progress={constraint} />
                ))}
              </div>
            ) : (
              <div className="tip-card">
                All milestone tiers complete. Keep pushing score and city grade.
              </div>
            )}
          </section>

          <section className="panel-section">
            <h2>Pressure</h2>
            <div className="tip-list">
              {blockers.map((tip) => (
                <div className="tip-card" key={tip}>
                  {tip}
                </div>
              ))}
            </div>
          </section>

          <section className="panel-section">
            <h2>Focus</h2>
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
            <p className="panel-note">{overlayInsight}</p>
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

        <main className={viewportClassName}>
          <div className="viewport-header">
            <div className="viewport-chip">
              Focus <strong>{activeOverlay?.title ?? overlay}</strong>
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
            <div className={`viewport-chip ${(progression?.pressureTier ?? 1) >= 3 ? "negative" : "positive"}`}>
              Threat <strong>T{progression?.pressureTier ?? 1}</strong>
            </div>
          </div>

          <CityRenderer
            snapshot={snapshot}
            overlay={overlay}
            tool={tool}
            theme={systemTheme}
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
            <h2>Progression</h2>
            <div className="stat-grid">
              <Stat label="Stage" value={stageNumber(progression)} />
              <Stat label="Score" value={progression?.score ?? 0} />
              <Stat label="Grade" value={progression?.cityGrade ?? "D"} />
              <Stat label="Budget Streak" value={stats?.positiveBudgetStreak ?? 0} />
              <Stat label="Trip Rate" value={(stats?.tripCompletionRate ?? 0) * 100} />
              <Stat label="Threat" value={progression?.threatLevel ?? 0} />
            </div>
            <div className="doc-body compact">
              <p>
                Unlocks:{" "}
                {progression
                  ? summarizeUnlocks(progression)
                  : "No progression data yet."}
              </p>
              <p>
                Latest reward:{" "}
                {progression?.rewardLog[0] ?? "No milestone rewards yet."}
              </p>
            </div>
          </section>

          <section className="panel-section">
            <h2>Demand</h2>
            <DemandBar label="Residential" value={stats?.demandResidential ?? 0} />
            <DemandBar label="Commercial" value={stats?.demandCommercial ?? 0} />
            <DemandBar label="Industrial" value={stats?.demandIndustrial ?? 0} />
          </section>

          <section className="panel-section">
            <h2>Network Pressure</h2>
            <DemandBar label="Trip Completion" value={(stats?.tripCompletionRate ?? 0) * 100} />
            <DemandBar label="Service Reliability" value={(stats?.avgServiceReliability ?? 0) * 100} />
            <DemandBar label="Congestion Stress" value={(stats?.congestionStress ?? 0) * 100} />
            <DemandBar label="Debt Pressure" value={stats?.debtPressure ?? 0} />
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
              <div className="ledger-row">
                <span>Productive jobs</span>
                <strong>{stats ? stats.productiveJobs.toFixed(1) : "0.0"}</strong>
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
                Traffic focus highlights the roads and queues that are genuinely under
                pressure instead of swapping the whole canvas into a different view.
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

const Stat = ({ label, value }: { label: string; value: number | string }) => (
  <div className="stat-card">
    <span>{label}</span>
    <strong>
      {typeof value === "number"
        ? Number.isFinite(value)
          ? value.toFixed(value % 1 === 0 ? 0 : 1)
          : 0
        : value}
    </strong>
  </div>
);

const ProgressMetric = ({
  progress,
  emphasize = false
}: {
  progress: MilestoneConstraintProgress;
  emphasize?: boolean;
}) => {
  const ratio = progress.comparator === "gte"
    ? clampProgress(progress.current / Math.max(progress.target, 1))
    : clampProgress(progress.target / Math.max(progress.current, progress.target, 1));

  return (
    <div className="demand-row">
      <span>{emphasize ? `Primary: ${progress.label}` : progress.label}</span>
      <div className="demand-track">
        <div className="demand-fill" style={{ width: `${ratio * 100}%` }} />
      </div>
      <strong>{formatProgress(progress)}</strong>
    </div>
  );
};

const DemandBar = ({ label, value }: { label: string; value: number }) => (
  <div className="demand-row">
    <span>{label}</span>
    <div className="demand-track">
      <div className="demand-fill" style={{ width: `${value}%` }} />
    </div>
    <strong>{Math.round(value)}</strong>
  </div>
);

const clampProgress = (value: number) => Math.max(0, Math.min(1, value));

const formatProgress = (progress: MilestoneConstraintProgress) =>
  `${progress.current.toFixed(progress.current >= 1 ? 0 : 2)} / ${progress.target.toFixed(
    progress.target >= 1 ? 0 : 2
  )}`;

const stageNumber = (progression: ProgressionState | null) => {
  const order = ["bootstrap", "town", "logistics", "resilience"];
  if (!progression) {
    return 0;
  }

  return order.indexOf(progression.currentStage) + 1;
};

const summarizeUnlocks = (progression: ProgressionState) => {
  const labels = [
    progression.unlocks.denserZones ? "denser zoning" : null,
    progression.unlocks.arterialRoads ? "arterial roads" : null,
    progression.unlocks.advancedPowerPlants ? "advanced grid hubs" : null,
    progression.unlocks.occupancyCapBonus > 0
      ? `+${progression.unlocks.occupancyCapBonus} occupancy cap`
      : null
  ].filter(Boolean);

  return labels.length > 0 ? labels.join(", ") : "base infrastructure only";
};
