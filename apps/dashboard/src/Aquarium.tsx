import { useEffect, useRef } from "react";
import { drawPixelNumber, fishSprite, hueFor, palettes, FISH_H, FISH_W } from "./pixel";

export interface AquariumAgent {
  agentId: string;
  personaId: string;
  personaName: string;
  emoji: string;
  status:
    | "queued"
    | "starting"
    | "browsing"
    | "thinking"
    | "confused"
    | "done"
    | "gave_up"
    | "error"
    | "stopped";
  step: number;
  lastThought: string;
}

interface Props {
  agents: AquariumAgent[];
  swarmTotal: number;
  findings: number;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}

interface Fish {
  id: string;
  hue: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Tail-beat accumulator; advances faster the harder the fish is swimming. */
  tail: number;
  /** Burst-and-glide phase — real fish pulse rather than cruise at constant speed. */
  burst: number;
  /** Persistent depth offset so agents at the same funnel step don't stack into a wall. */
  jitter: number;
  bob: number;
  targetY: number;
  state: "normal" | "confused" | "done" | "gone" | "queued";
  flash: number;
  scale: number;
  name: string;
}

const SKY = ["#2b1055", "#7b3fa0", "#c4508a", "#f08a5d", "#ffc478"];
const WATER_TOP = "#1d6a8f";
const WATER_DEEP = "#04121f";

/** How far down the funnel this agent has got, 0 (surface) → 1 (converted, seabed). */
function progressOf(a: AquariumAgent): number {
  if (a.status === "done") return 0.93; // rests just above the seabed, not buried in it
  if (a.status === "gave_up" || a.status === "stopped" || a.status === "error") return 0.05;
  if (a.status === "queued") return 0.1; // milling about near the surface, not started yet
  return Math.min(0.82, 0.14 + a.step * 0.055);
}

function stateOf(a: AquariumAgent): Fish["state"] {
  if (a.status === "done") return "done";
  if (a.status === "gave_up" || a.status === "stopped" || a.status === "error") return "gone";
  if (a.status === "confused") return "confused";
  if (a.status === "queued") return "queued";
  return "normal";
}

export function Aquarium({ agents, swarmTotal, findings, selectedId, onSelect }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fishRef = useRef<Map<string, Fish>>(new Map());
  const agentsRef = useRef(agents);
  const metaRef = useRef({ swarmTotal, findings, selectedId });
  const hoverRef = useRef<{ x: number; y: number } | null>(null);

  agentsRef.current = agents;
  metaRef.current = { swarmTotal, findings, selectedId };

  useEffect(() => {
    const canvas = canvasRef.current!;
    const g = canvas.getContext("2d")!;
    let raf = 0;
    let t = 0;

    const bubbles = Array.from({ length: 34 }, () => ({
      x: Math.random(),
      y: Math.random(),
      r: 1 + Math.random() * 2,
      speed: 0.02 + Math.random() * 0.05,
    }));

    // Render at device-pixel resolution (capped 2x), draw in CSS units via transform —
    // crisp on hidpi screens and in 4K captures; fish logic and click mapping stay in
    // CSS coordinates untouched.
    let dpr = 1;
    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.max(320, Math.floor(rect.width * dpr));
      canvas.height = Math.max(240, Math.floor(rect.height * dpr));
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.imageSmoothingEnabled = false;
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    const frame = () => {
      t += 1;
      const W = canvas.width / dpr;
      const H = canvas.height / dpr;
      const list = agentsRef.current;
      const { swarmTotal: total, findings: findingCount, selectedId: sel } = metaRef.current;

      // ── water level: bigger swarm = deeper ocean ──
      // Driven by the swarm you ASKED for, not how many have spawned yet — otherwise a
      // 1000-agent run looks like a puddle for the first two minutes while it fills.
      // Log scale so 10 → 100 → 1000 each feel like a real step deeper.
      const fillRatio = Math.max(0, Math.min(1, Math.log10(Math.max(1, total)) / 3));
      const surfaceY = Math.round(H * (0.42 - 0.33 * fillRatio));
      const seabedY = H - 34;

      // Fish shrink as the shoal grows, so a thousand still fit legibly — but not too
      // small: most of a big swarm is queued/waving at any moment, and a tank of
      // near-invisible fish reads as empty rather than vast.
      const scale =
        list.length > 600 ? 1.9 : list.length > 250 ? 2.3 : list.length > 80 ? 2.7 : list.length > 24 ? 3.1 : 3.6;

      // ── sky ──
      const sky = g.createLinearGradient(0, 0, 0, Math.max(surfaceY, 1));
      SKY.forEach((c, i) => sky.addColorStop(i / (SKY.length - 1), c));
      g.fillStyle = sky;
      g.fillRect(0, 0, W, surfaceY);

      // moon + stars
      g.fillStyle = "#fff7d6";
      g.fillRect(W - 90, 26, 26, 26);
      g.fillStyle = SKY[0];
      g.fillRect(W - 82, 20, 22, 22);
      g.fillStyle = "rgba(255,255,255,0.8)";
      for (let i = 0; i < 26; i++) {
        const sx = (i * 197) % W;
        const sy = (i * 71) % Math.max(1, surfaceY - 8);
        if (Math.sin(t * 0.03 + i) > 0.3) g.fillRect(sx, sy, 2, 2);
      }

      // ── water ──
      const water = g.createLinearGradient(0, surfaceY, 0, H);
      water.addColorStop(0, WATER_TOP);
      water.addColorStop(1, WATER_DEEP);
      g.fillStyle = water;
      g.fillRect(0, surfaceY, W, H - surfaceY);

      // chunky pixel waves on the surface
      for (let x = 0; x < W; x += 8) {
        const h = Math.round(Math.sin(x * 0.06 + t * 0.05) * 3);
        g.fillStyle = "#3fa7c9";
        g.fillRect(x, surfaceY + h, 8, 4);
        g.fillStyle = "rgba(255,255,255,0.25)";
        g.fillRect(x, surfaceY + h, 8, 2);
      }

      // god rays
      g.save();
      g.globalAlpha = 0.06;
      for (let i = 0; i < 5; i++) {
        const rx = ((i * 260 + t * 0.4) % (W + 300)) - 150;
        g.fillStyle = "#9fe8ff";
        g.beginPath();
        g.moveTo(rx, surfaceY);
        g.lineTo(rx + 70, surfaceY);
        g.lineTo(rx + 190, H);
        g.lineTo(rx - 40, H);
        g.closePath();
        g.fill();
      }
      g.restore();

      // ── funnel depth guides ──
      const bands: [number, string][] = [
        [0.12, "ARRIVED"],
        [0.4, "BROWSING"],
        [0.68, "CHECKOUT"],
        [1, "CONVERTED"],
      ];
      g.font = "10px ui-monospace, monospace";
      for (const [p, label] of bands) {
        const y = surfaceY + (seabedY - surfaceY) * p;
        g.strokeStyle = "rgba(159,232,255,0.10)";
        g.setLineDash([4, 6]);
        g.beginPath();
        g.moveTo(0, y);
        g.lineTo(W, y);
        g.stroke();
        g.setLineDash([]);
        g.fillStyle = "rgba(159,232,255,0.32)";
        g.fillText(label, 10, y - 4);
      }

      // ── bubbles ──
      g.fillStyle = "rgba(255,255,255,0.25)";
      for (const b of bubbles) {
        b.y -= b.speed / 100;
        if (b.y < 0) {
          b.y = 1;
          b.x = Math.random();
        }
        const by = surfaceY + (H - surfaceY) * b.y;
        g.fillRect(Math.round(b.x * W), Math.round(by), Math.round(b.r), Math.round(b.r));
      }

      // ── sync fish to agents ──
      const fish = fishRef.current;
      const seen = new Set<string>();
      for (const a of list) {
        seen.add(a.agentId);
        let f = fish.get(a.agentId);
        if (!f) {
          // An agent that already has progress (page refresh, or a tab that was hidden
          // while the run advanced) spawns AT its depth — only genuinely new arrivals
          // enter from the surface. Otherwise every refresh rains fish from the sky.
          const jitter = (Math.random() - 0.5) * 0.13;
          const depth = Math.max(0.02, Math.min(0.97, progressOf(a) + jitter));
          const settled = surfaceY + (seabedY - surfaceY) * depth;
          const spawnY = stateOf(a) === "queued" ? surfaceY + 10 : settled;
          f = {
            id: a.agentId,
            hue: hueFor(a.personaId),
            x: Math.random() * W,
            y: spawnY,
            vx: (Math.random() < 0.5 ? -1 : 1) * (0.4 + Math.random() * 0.7),
            vy: 0,
            tail: Math.random() * 10,
            burst: Math.random() * Math.PI * 2,
            jitter,
            bob: Math.random() * Math.PI * 2,
            targetY: spawnY,
            state: "normal",
            flash: 0,
            scale,
            name: a.personaName,
          };
          fish.set(a.agentId, f);
        }
        const st = stateOf(a);
        if (st === "confused" && f.state !== "confused") f.flash = 40;
        f.state = st;
        f.scale = scale;
        const depth = Math.max(0.02, Math.min(0.97, progressOf(a) + f.jitter));
        f.targetY = surfaceY + (seabedY - surfaceY) * depth;
      }
      for (const id of [...fish.keys()]) if (!seen.has(id)) fish.delete(id);

      // ── swim + draw ──
      for (const f of fish.values()) {
        const dead = f.state === "gone";
        const idle = f.state === "queued";

        // Burst-and-glide: fish pulse rather than cruise, so speed oscillates.
        // Queued fish mill about slowly; they haven't started working yet.
        f.burst += 0.035;
        const effort = dead ? 0.15 : idle ? 0.3 : 0.55 + 0.65 * (0.5 + 0.5 * Math.sin(f.burst));

        // Occasionally turn around, so the shoal doesn't drift into a single current.
        if (!dead && Math.random() < 0.0022) f.vx = -f.vx;

        // Vertical: accelerate toward the funnel depth, damped — this is what makes a
        // fish angle downward as it descends instead of teleporting between bands.
        const gap = f.targetY - f.y;
        f.vy = f.vy * 0.92 + gap * 0.0035;

        f.bob += 0.06;
        f.x += f.vx * effort;
        f.y += f.vy + Math.sin(f.bob) * (dead ? 0.12 : 0.22);

        if (f.x < -40) f.x = W + 30;
        if (f.x > W + 40) f.x = -30;

        // Tail beats faster the harder it's working; dead fish barely twitch.
        f.tail += dead ? 0.02 : 0.22 + effort * 0.34;
        if (f.flash > 0) f.flash--;

        const pal = palettes(f.hue)[f.state];
        const facingLeft = f.vx < 0;
        const frame = Math.floor(f.tail) % 3;
        const sprite = fishSprite(pal, facingLeft, frame, `${f.hue}-${f.state}`);
        const w = FISH_W * f.scale;
        const h = FISH_H * f.scale;

        // Pitch the body toward travel direction — the other half of "swimming".
        // Kept shallow (~15°); anything steeper reads as a fish falling, not swimming.
        const pitch = Math.max(-0.26, Math.min(0.26, f.vy * 0.35)) * (facingLeft ? -1 : 1);

        g.save();
        g.translate(Math.round(f.x), Math.round(f.y));
        if (dead) {
          g.globalAlpha = 0.5;
          g.scale(1, -1); // belly-up
        } else if (idle) {
          g.globalAlpha = 0.72; // queued fish are part of the shoal, not ghosts
          g.rotate(pitch);
        } else {
          g.rotate(pitch);
          if (f.flash > 0 && Math.floor(t / 4) % 2 === 0) {
            g.shadowColor = "#ffb648";
            g.shadowBlur = 14;
          }
        }
        g.drawImage(sprite, -w / 2, -h / 2, w, h);
        g.restore();

        const x = Math.round(f.x - w / 2);
        const y = Math.round(f.y - h / 2);

        if (f.id === sel) {
          g.strokeStyle = "#ffe89a";
          g.lineWidth = 2;
          g.strokeRect(x - 4, y - 4, w + 8, h + 8);
          g.fillStyle = "#ffe89a";
          g.font = "11px ui-monospace, monospace";
          g.fillText(f.name, x - 4, y - 10);
        }
      }

      // ── seabed ──
      g.fillStyle = "#0b2233";
      g.fillRect(0, seabedY, W, H - seabedY);
      g.fillStyle = "#123449";
      for (let x = 0; x < W; x += 6) {
        const h = 4 + ((x * 7919) % 11);
        g.fillRect(x, seabedY - h + 4, 6, h);
      }
      // kelp
      g.fillStyle = "#0f4d3a";
      for (let i = 0; i < W; i += 140) {
        const sway = Math.sin(t * 0.02 + i) * 4;
        for (let s = 0; s < 6; s++) {
          g.fillRect(i + 30 + sway * (s / 6), seabedY - s * 9, 5, 9);
        }
      }

      // ── HUD ──
      const done = list.filter((a) => a.status === "done").length;
      const quit = list.filter((a) => ["gave_up", "error", "stopped"].includes(a.status)).length;
      const hudY = 18;
      g.fillStyle = "rgba(4,12,20,0.55)";
      g.fillRect(12, hudY - 6, 330, 40);
      g.font = "9px ui-monospace, monospace";
      g.fillStyle = "#9fe8ff";
      g.fillText("SWIMMING", 22, hudY + 6);
      g.fillText("CONVERTED", 132, hudY + 6);
      g.fillText("QUIT", 246, hudY + 6);
      drawPixelNumber(g, String(list.length - done - quit), 22, hudY + 12, 3, "#9fe8ff");
      drawPixelNumber(g, String(done), 132, hudY + 12, 3, "#ffd34d");
      drawPixelNumber(g, String(quit), 246, hudY + 12, 3, "#ff8b4a");

      // findings counter, bottom-right
      g.fillStyle = "rgba(4,12,20,0.55)";
      g.fillRect(W - 150, H - 40, 138, 28);
      g.fillStyle = "#ff8b4a";
      g.font = "9px ui-monospace, monospace";
      g.fillText("FINDINGS", W - 140, H - 26);
      drawPixelNumber(g, String(findingCount), W - 78, H - 34, 3, "#ff8b4a");

      // hover label
      const hover = hoverRef.current;
      if (hover) {
        let nearest: Fish | null = null;
        let best = 30 * 30;
        for (const f of fish.values()) {
          const dx = f.x - hover.x;
          const dy = f.y - hover.y;
          const d = dx * dx + dy * dy;
          if (d < best) {
            best = d;
            nearest = f;
          }
        }
        if (nearest) {
          g.fillStyle = "rgba(4,12,20,0.85)";
          const label = nearest.name;
          const tw = label.length * 6 + 12;
          g.fillRect(hover.x + 10, hover.y - 22, tw, 18);
          g.fillStyle = "#e6f6ff";
          g.font = "11px ui-monospace, monospace";
          g.fillText(label, hover.x + 16, hover.y - 9);
        }
      }

      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    // Automation affordance: fish live on a canvas, so there is nothing for a test or
    // script to target. Expose their positions (canvas-relative CSS px) and state so
    // anything driving the dashboard can click a specific agent deliberately.
    (window as unknown as { __shoalFish?: unknown }).__shoalFish = () =>
      [...fishRef.current.values()].map((f) => ({ id: f.id, x: f.x, y: f.y, state: f.state }));

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      delete (window as unknown as { __shoalFish?: unknown }).__shoalFish;
    };
  }, []);

  const pick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    let nearest: string | null = null;
    // Generous radius: fish are small targets and this is a glanceable view, not a game.
    let best = 55 * 55;
    for (const f of fishRef.current.values()) {
      const d = (f.x - mx) ** 2 + (f.y - my) ** 2;
      if (d < best) {
        best = d;
        nearest = f.id;
      }
    }
    onSelect(nearest);
  };

  return (
    <canvas
      ref={canvasRef}
      className="aquarium"
      onClick={pick}
      onMouseMove={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        hoverRef.current = { x: e.clientX - r.left, y: e.clientY - r.top };
      }}
      onMouseLeave={() => (hoverRef.current = null)}
    />
  );
}
