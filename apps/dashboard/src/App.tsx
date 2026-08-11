import { useEffect, useRef, useState } from "react";
import { Aquarium } from "./Aquarium";

interface AgentState {
  agentId: string;
  personaId: string;
  personaName: string;
  emoji: string;
  status: "queued" | "starting" | "browsing" | "thinking" | "confused" | "done" | "gave_up" | "error" | "stopped";
  step: number;
  lastThought: string;
  lastAction: string;
  screenshot?: string;
}

interface Finding {
  agentId: string;
  personaName: string;
  severity: "low" | "medium" | "high";
  title: string;
  description: string;
  ts: number;
  verdict?: { status: "confirmed" | "suspect"; note: string };
}

interface Thought {
  agentId: string;
  personaName: string;
  emoji: string;
  text: string;
  ts: number;
  /** Multi-user handoff line (rendered as a highlighted rail entry). */
  handoff?: { event: string; note?: string };
}

interface RunConfig {
  scene?: string;
  task: string;
  url: string;
  swarm: number;
  mock: boolean;
  provider?: string;
}

/** A row of the live friction map — an issue and how much of the swarm hit it. */
interface FrictionCluster {
  title: string;
  severity: "low" | "medium" | "high";
  reach: number;
  personas: number;
  suspect: boolean;
}

const STATUS_LABEL: Record<AgentState["status"], string> = {
  queued: "queued",
  starting: "starting",
  browsing: "browsing",
  thinking: "thinking",
  confused: "confused",
  done: "done ✓",
  gave_up: "gave up ✗",
  error: "error ⚠",
  stopped: "stopped ⏹",
};

const SEV_ICON = { high: "🔴", medium: "🟡", low: "🔵" } as const;

interface RunState {
  phase: "idle" | "running" | "stopping" | "finished";
  swarm: number;
  strategy?: string;
  task: string;
  runNumber: number;
  strategies?: { id: string; name: string }[];
}

export function App() {
  const [agents, setAgents] = useState<Map<string, AgentState>>(new Map());
  const [thoughts, setThoughts] = useState<Thought[]>([]);
  const [findings, setFindings] = useState<Finding[]>([]);
  const [clusters, setClusters] = useState<FrictionCluster[]>([]);
  const [clusterTotal, setClusterTotal] = useState(0);
  const [config, setConfig] = useState<RunConfig | null>(null);
  const [cost, setCost] = useState<{ costUsd: number | null; tokens: number } | null>(null);
  const [connected, setConnected] = useState(false);
  const [run, setRun] = useState<RunState | null>(null);
  // Draft config the operator edits before hitting restart.
  const [draftSwarm, setDraftSwarm] = useState<number | null>(null);
  const [draftStrategy, setDraftStrategy] = useState<string | null>(null);
  const [view, setView] = useState<"aquarium" | "wall">("aquarium");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const feedRef = useRef<HTMLDivElement>(null);
  const socketRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    let socket: WebSocket;
    let retry: ReturnType<typeof setTimeout>;
    const connect = () => {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      socket = new WebSocket(`${proto}://${location.host}/ws`);
      socketRef.current = socket;
      socket.onopen = () => setConnected(true);
      socket.onclose = () => {
        setConnected(false);
        retry = setTimeout(connect, 1500);
      };
      socket.onmessage = (msg) => {
        const ev = JSON.parse(msg.data);
        if (ev.type === "run_config") {
          setConfig(ev);
          // A small scene is a 2-agent story told as side-by-side browsers; a scaled scene
          // (a crowd of buyers) is a shoal, so keep the tank there.
          if (ev.scene && ev.swarm <= 6) setView("wall");
          else if (ev.scene) setView("aquarium");
        } else if (ev.type === "handoff")
          setThoughts((prev) => [
            ...prev.slice(-80),
            {
              agentId: "handoff",
              personaName: ev.from,
              emoji: ev.fromEmoji,
              text: `→ ${ev.event}`,
              ts: ev.ts,
              handoff: { event: ev.event, note: ev.note },
            },
          ]);
        else if (ev.type === "run_state") setRun(ev);
        else if (ev.type === "run_reset") {
          setAgents(new Map());
          setThoughts([]);
          setFindings([]);
          setClusters([]);
          setClusterTotal(0);
          setCost(null);
        } else if (ev.type === "clusters") {
          setClusters(ev.clusters);
          setClusterTotal(ev.total);
        } else if (ev.type === "agent_state")
          setAgents((prev) => new Map(prev).set(ev.state.agentId, ev.state));
        else if (ev.type === "agent_batch")
          // One setState for the whole swarm — 1000 individual updates would jank.
          setAgents((prev) => {
            const next = new Map(prev);
            for (const s of ev.states) next.set(s.agentId, s);
            return next;
          });
        else if (ev.type === "thought")
          setThoughts((prev) => [...prev.slice(-80), ev]);
        else if (ev.type === "finding")
          setFindings((prev) => [...prev, ev.finding]);
        else if (ev.type === "cost")
          setCost({ costUsd: ev.costUsd, tokens: ev.usage.input + ev.usage.cacheRead + ev.usage.cacheWrite + ev.usage.output });
        else if (ev.type === "run_done" && ev.summary)
          setCost({ costUsd: ev.summary.costUsd, tokens: ev.summary.usage.input + ev.summary.usage.cacheRead + ev.summary.usage.cacheWrite + ev.summary.usage.output });
      };
    };
    connect();
    return () => {
      clearTimeout(retry);
      socket?.close();
    };
  }, []);

  const send = (cmd: Record<string, unknown>) => {
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify(cmd));
    }
  };
  const swarmValue = draftSwarm ?? run?.swarm ?? 8;
  const strategyValue = draftStrategy ?? run?.strategy ?? "default";
  const restart = () => {
    send({ cmd: "restart", swarm: swarmValue, strategy: strategyValue });
    setDraftSwarm(null);
    setDraftStrategy(null);
  };

  useEffect(() => {
    feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight, behavior: "smooth" });
  }, [thoughts]);

  const list = [...agents.values()];
  const running = list.filter(
    (a) => !["done", "gave_up", "error", "stopped", "queued"].includes(a.status),
  ).length;
  const queued = list.filter((a) => a.status === "queued").length;
  const done = list.filter((a) => a.status === "done").length;
  const gaveUp = list.filter((a) => a.status === "gave_up").length;
  // Past ~24 agents not every agent can stream video, so the cams view shows the ones
  // that are — the tank view is what represents the whole swarm.
  const schoolMode = list.length > 24;
  // Live agents first — a finished agent keeps its last frame, but the strip should show
  // fish that are still swimming (the featured set rotates server-side as agents finish).
  const withFrames = schoolMode ? list.filter((a) => a.screenshot) : list;
  const live = withFrames.filter((a) => !["done", "gave_up", "error", "stopped"].includes(a.status));
  const featured = schoolMode ? [...live, ...withFrames.filter((a) => !live.includes(a))].slice(0, 18) : list;
  const selected = selectedId ? agents.get(selectedId) ?? null : null;

  return (
    <div className="layout">
      <header>
        <div className="brand">
          <span className="logo">🐟</span>
          <h1>shoal</h1>
          <span className="tagline">a swarm of AI users attacking your site</span>
        </div>
        <div className="stats">
          {config && <span className="task" title={config.task}>“{config.task}”</span>}
          <span className="pill running">{running} swimming</span>
          {queued > 0 && <span className="pill queued">{queued} waiting</span>}
          <span className="pill ok">{done} done</span>
          <span className="pill bad">{gaveUp} gave up</span>
          <span className="pill flag">🚩 {findings.length}</span>
          {(cost || config?.mock) && (
            <span
              className="pill cost"
              title={
                config?.provider === "subscription"
                  ? `Claude subscription — flat fee · ${cost ? (cost.tokens / 1000).toFixed(0) : 0}k tokens`
                  : cost
                    ? `${(cost.tokens / 1000).toFixed(0)}k tokens`
                    : "mock mode"
              }
            >
              {config?.mock
                ? "$0.00"
                : config?.provider === "subscription"
                  ? `$0 · sub`
                  : cost!.costUsd !== null
                    ? `$${cost!.costUsd.toFixed(cost!.costUsd < 1 ? 3 : 2)}`
                    : `${(cost!.tokens / 1000).toFixed(0)}k tok`}
            </span>
          )}
          <span className={`dot ${connected ? "on" : "off"}`} title={connected ? "connected" : "reconnecting…"} />
        </div>
      </header>

      {run && (
        <div className="controls">
          <span className={`phase ${run.phase}`}>
            {run.phase === "running" && "● running"}
            {run.phase === "stopping" && "◌ stopping…"}
            {run.phase === "finished" && "■ finished"}
            {run.phase === "idle" && "○ idle"}
            {run.runNumber > 1 && <span className="runno"> · run #{run.runNumber}</span>}
          </span>

          <button
            className="ctrl stop"
            disabled={run.phase !== "running"}
            onClick={() => send({ cmd: "stop" })}
            title="Stop every agent as soon as it finishes its current step"
          >
            ⏹ Stop
          </button>
          <button
            className="ctrl restart"
            disabled={run.phase === "stopping"}
            onClick={restart}
            title="Stop anything in flight and launch a fresh swarm"
          >
            ↻ {run.phase === "running" ? "Restart" : "Run again"}
          </button>

          <label className="ctrl-field">
            swarm
            <input
              type="number"
              min={1}
              max={5000}
              value={swarmValue}
              onChange={(e) => setDraftSwarm(Number(e.target.value))}
            />
          </label>

          <label className="ctrl-field">
            strategy
            <select value={strategyValue} onChange={(e) => setDraftStrategy(e.target.value)}>
              <option value="default">default</option>
              {run.strategies?.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>

          {(draftSwarm !== null || draftStrategy !== null) && (
            <span className="pending-note">applies on restart</span>
          )}

          <div className="view-toggle">
            <button
              className={view === "aquarium" ? "on" : ""}
              onClick={() => setView("aquarium")}
              title="The shoal — every agent as a fish, depth = funnel progress"
            >
              🐟 tank
            </button>
            <button
              className={view === "wall" ? "on" : ""}
              onClick={() => setView("wall")}
              title="Camera wall — live browser viewports"
            >
              ▦ cams
            </button>
          </div>
        </div>
      )}

      <div className="body">
        {view === "aquarium" ? (
          <main className="tank">
            <Aquarium
              agents={list}
              swarmTotal={run?.swarm ?? list.length ?? 1}
              findings={findings.length}
              selectedId={selectedId}
              onSelect={(id) => {
                setSelectedId(id);
                // Ask the server to start streaming this agent's screen.
                send({ cmd: "focus", agentId: id });
              }}
            />
            {selected && (
              <div className="drilldown">
                <div className="dd-head">
                  <span className="dd-who">
                    {selected.emoji} {selected.personaName}
                  </span>
                  <span className={`badge ${selected.status}`}>{STATUS_LABEL[selected.status]}</span>
                  <button className="dd-close" onClick={() => setSelectedId(null)}>
                    ✕
                  </button>
                </div>
                <div className="dd-view">
                  {selected.screenshot ? (
                    <img src={`data:image/jpeg;base64,${selected.screenshot}`} alt={selected.personaName} />
                  ) : (
                    <div className="dd-nofeed">
                      no live feed for this agent
                      <span>(only featured agents stream video in large swarms)</span>
                    </div>
                  )}
                </div>
                <div className="dd-thought">“{selected.lastThought}”</div>
                <div className="dd-meta">
                  step {selected.step}
                  {selected.strategyName ? ` · ${selected.strategyName}` : ""}
                  {selected.modality === "a11y" ? " · screen reader" : ""}
                </div>
              </div>
            )}
          </main>
        ) : (
        <main className="wall">
          {list.length === 0 && (
            <div className="empty">
              <p>🐟 waiting for the swarm…</p>
              <code>npm run demo</code>
            </div>
          )}
          {featured.map((a) => (
            <div key={a.agentId} className={`cam ${a.status}`}>
              <div className="cam-head">
                <span className="who">{a.emoji} {a.personaName}</span>
                <span className={`badge ${a.status}`}>{STATUS_LABEL[a.status]}</span>
              </div>
              <div className="viewport">
                {a.screenshot ? (
                  <img src={`data:image/jpeg;base64,${a.screenshot}`} alt={a.personaName} />
                ) : (
                  <div className="static" />
                )}
                {a.status === "confused" && <div className="flash" />}
              </div>
              {a.lastThought && <div className="thought">“{a.lastThought}”</div>}
            </div>
          ))}
        </main>
        )}

        <aside>
          {clusters.length > 0 && !config?.scene && (
            <section className="friction">
              <h2>
                Friction map <span className="count">{clusters.length} issues</span>
                {clusterTotal > 0 && <span className="fr-sub">across {clusterTotal} users</span>}
              </h2>
              <div className="friction-list">
                {clusters.slice(0, 10).map((c, i) => {
                  const pct = clusterTotal > 0 ? Math.round((c.reach / clusterTotal) * 100) : 0;
                  return (
                    <div key={i} className={`fr-row ${c.severity}${c.suspect ? " suspect" : ""}`}>
                      <div className="fr-fill" style={{ width: `${Math.max(4, pct)}%` }} />
                      <span className="fr-rank">#{i + 1}</span>
                      <span className="fr-title">
                        {SEV_ICON[c.severity]} {c.title}
                        {c.suspect && <span className="fr-suspect" title="Verifier flagged as possible agent artifact">?</span>}
                      </span>
                      <span className="fr-reach">
                        <strong>{c.reach}</strong> <em>hit</em> <span className="fr-pct">{pct}%</span>
                      </span>
                    </div>
                  );
                })}
              </div>
            </section>
          )}
          <section className="feed-wrap">
            <h2>Live feed</h2>
            <div className="feed" ref={feedRef}>
              {thoughts.map((t, i) =>
                t.handoff ? (
                  <div key={i} className="feed-item handoff">
                    <span className="handoff-badge">🔗 handoff</span>
                    <span className="feed-who">{t.emoji} {t.personaName}</span>
                    <span className="feed-text">
                      {t.handoff.event}
                      {t.handoff.note ? ` — “${t.handoff.note}”` : ""}
                    </span>
                  </div>
                ) : (
                  <div key={i} className="feed-item">
                    <span className="feed-who">{t.emoji} {t.personaName}</span>
                    <span className="feed-text">{t.text}</span>
                  </div>
                ),
              )}
            </div>
          </section>
          <section className="findings">
            <h2>Findings <span className="count">{findings.length}</span></h2>
            <div className="finding-list">
              {findings.length === 0 && <p className="none">Nothing yet. Give them a minute.</p>}
              {[...findings].reverse().map((f, i) => (
                <div key={i} className={`finding ${f.severity}`}>
                  <div className="f-title">
                    {SEV_ICON[f.severity]} {f.title}
                    {f.verdict && (
                      <span className={`verdict ${f.verdict.status}`} title={f.verdict.note}>
                        {f.verdict.status === "confirmed" ? "✓ verified" : "? suspect"}
                      </span>
                    )}
                  </div>
                  <div className="f-desc">{f.description}</div>
                  <div className="f-who">— {f.personaName}</div>
                </div>
              ))}
            </div>
          </section>
        </aside>
      </div>
    </div>
  );
}
