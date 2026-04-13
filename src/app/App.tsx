import {
  startTransition,
  useCallback,
  useEffect,
  useRef,
  useState
} from "react";

import {
  DEFAULT_OVERLAY,
  DEFAULT_TOOL,
  DEFAULT_TIME_SCALE,
  SAVE_SLOT_KEY,
  WORLD_HEIGHT,
  WORLD_WIDTH
} from "../shared/constants";
import { toWorkerMessage, type WorkerToMainMessage } from "../shared/messages";
import type {
  NotificationMessage,
  OverlayKind,
  SimSnapshot,
  TimeScale,
  ToolMode
} from "../shared/types";
import { CityRenderer, type CanvasAction } from "../main/CityRenderer";
import {
  loadGameFromIndexedDb,
  saveGameToIndexedDb
} from "../main/storage";

const tools: Array<{ id: ToolMode; label: string }> = [
  { id: "road", label: "Road" },
  { id: "bulldoze", label: "Bulldoze" },
  { id: "zone-residential", label: "Zone R" },
  { id: "zone-commercial", label: "Zone C" },
  { id: "zone-industrial", label: "Zone I" },
  { id: "service-power", label: "Power" }
];

const overlays: OverlayKind[] = ["traffic", "power", "happiness"];
const timeScales: TimeScale[] = [0, 1, 2, 3];

export const App = () => {
  const workerRef = useRef<Worker | null>(null);
  const [snapshot, setSnapshot] = useState<SimSnapshot | null>(null);
  const [overlay, setOverlay] = useState<OverlayKind>(DEFAULT_OVERLAY);
  const [tool, setTool] = useState<ToolMode>(DEFAULT_TOOL);
  const [notifications, setNotifications] = useState<NotificationMessage[]>([]);
  const [isPersisting, setIsPersisting] = useState(false);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);

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
            ...current.slice(0, 4)
          ]);
          break;
        case "saveReady":
          setIsPersisting(true);
          await saveGameToIndexedDb(message.payload.saveGame, message.payload.slotKey);
          setNotifications((current) => [
            {
              id: Date.now(),
              level: "info",
              text: "Save written to IndexedDB."
            },
            ...current.slice(0, 4)
          ]);
          setIsPersisting(false);
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

    return () => {
      worker.terminate();
      workerRef.current = null;
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

  const handleSave = useCallback(() => {
    send("saveGame", { slotKey: SAVE_SLOT_KEY });
  }, [send]);

  const handleLoad = async () => {
    const saveGame = await loadGameFromIndexedDb(SAVE_SLOT_KEY);
    if (!saveGame) {
      setNotifications((current) => [
        {
          id: Date.now(),
          level: "warning",
          text: "No save found in IndexedDB yet."
        },
        ...current.slice(0, 4)
      ]);
      return;
    }

    send("loadGame", { saveGame });
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-block">
          <p className="eyebrow">WebCities</p>
          <h1>Traffic Operations View</h1>
        </div>
        <div className="toolbar-cluster">
          <span className="toolbar-label">Tools</span>
          <div className="toolbar-strip">
            {tools.map((entry) => (
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
          <div className="toolbar-strip">
            <button onClick={handleSave} type="button">
              {isPersisting ? "Saving..." : "Save"}
            </button>
            <button onClick={handleLoad} type="button">
              Load
            </button>
          </div>
        </div>
      </header>

      <div className="workspace">
        <aside className="left-panel">
          <section className="panel-section">
            <h2>Construction</h2>
            <p className="lede">
              Roads snap to grid borders. Zones and utilities fill adjacent cells.
            </p>
          </section>

          <section className="panel-section">
            <h2>Overlay</h2>
            <div className="stacked-grid">
              {overlays.map((entry) => (
                <button
                  key={entry}
                  className={overlay === entry ? "is-active" : ""}
                  onClick={() => handleOverlayChange(entry)}
                  type="button"
                >
                  {entry}
                </button>
              ))}
            </div>
          </section>

          <section className="panel-section">
            <h2>Instructions</h2>
            <p className="hint">
              Left click builds. Right click or hold <code>Alt</code> to pan. Mouse
              wheel zooms. Use traffic overlay to inspect bottlenecks and outage
              recovery delays.
            </p>
          </section>
        </aside>

        <main className="viewport">
          <div className="viewport-header">
            <div className="viewport-chip">
              Overlay <strong>{overlay}</strong>
            </div>
            <div className="viewport-chip">
              Active tool <strong>{tool.replace("zone-", "")}</strong>
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
              <Stat
                label="Budget"
                value={Math.round(snapshot?.cityStats.budget ?? 0)}
              />
              <Stat label="Outages" value={snapshot?.cityStats.outages ?? 0} />
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
                  No events yet. Build a road network and place zones to start demand.
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
