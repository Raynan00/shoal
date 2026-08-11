import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, extname, join, normalize } from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import type { ControlCommand, ShoalEvent } from "./types.js";

const here = dirname(fileURLToPath(import.meta.url));
const DASHBOARD_DIST = join(here, "..", "..", "..", "apps", "dashboard", "dist");
const BAIT_SHOP_DIR = join(here, "..", "..", "..", "apps", "bait-shop");

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
};

async function serveFile(root: string, rel: string): Promise<{ body: Buffer; mime: string } | null> {
  const path = normalize(join(root, rel));
  if (!path.startsWith(normalize(root))) return null; // no traversal
  if (!existsSync(path)) return null;
  try {
    const body = await readFile(path);
    return { body, mime: MIME[extname(path)] ?? "application/octet-stream" };
  } catch {
    return null;
  }
}

/**
 * One port for everything:
 *   /            → dashboard (built Vite app)
 *   /shop        → the bait shop demo store
 *   /ws          → live event stream (WebSocket)
 */
/**
 * The race target. Deliberately contains a textbook TOCTOU bug: stock is checked, then an
 * await gap opens, then it is decremented. Two requests inside that gap both "win" the
 * single unit. This is what race-mode agents contend for, and because the server knows the
 * truth we can detect the oversell as ground truth rather than agent opinion.
 */
class RaceResource {
  stock = 1;
  claims: { buyer: string; at: number; order: string }[] = [];

  reset(): void {
    this.stock = 1;
    this.claims = [];
  }

  async claim(buyer: string): Promise<{ ok: boolean; order?: string }> {
    if (this.stock <= 0) return { ok: false };
    // ── the bug: check happened above, write happens below, gap in between ──
    await new Promise((r) => setTimeout(r, 60));
    this.stock -= 1;
    const order = "FA-" + Math.floor(1000 + Math.random() * 9000);
    this.claims.push({ buyer, at: Date.now(), order });
    return { ok: true, order };
  }

  /** More successful claims than units = a real, provable oversell. */
  get oversold(): boolean {
    return this.claims.length > 1;
  }
}

/**
 * The multi-user (scene) target. A seller lists items; a buyer buys them. The planted bug
 * is a classic cross-user disconnect: buying records the sale in `sales` (ground truth)
 * but NEVER appends to `notifications`, which is what the seller's dashboard reads. So the
 * buyer sees success, the seller sees nothing, and only comparing the two reveals it.
 */
class MarketplaceResource {
  listings: { id: string; seller: string; title: string; price: number; sold: boolean; buyer?: string }[] = [];
  sales: { id: string; title: string; seller: string; buyer: string; at: number }[] = [];
  notifications: { title: string; buyer: string }[] = []; // the seller's queue — never written to (the bug)
  private seq = 0;

  reset(): void {
    this.listings = [];
    this.sales = [];
    this.notifications = [];
    this.seq = 0;
  }

  list(seller: string, title: string, price: number): string {
    const id = `lst-${this.seq++}`;
    this.listings.push({ id, seller, title, price, sold: false });
    return id;
  }

  async buy(id: string, buyer: string): Promise<{ ok: boolean; title?: string; order?: string }> {
    const l = this.listings.find((x) => x.id === id);
    if (!l || l.sold) return { ok: false };
    // ── TOCTOU gap: check above, write below. Concurrent buyers both pass the check and
    // both "win" the single unit — the flash-sale oversell bug. (Harmless with one buyer.)
    await new Promise((r) => setTimeout(r, 70));
    l.sold = true;
    l.buyer = buyer;
    this.sales.push({ id, title: l.title, seller: l.seller, buyer, at: Date.now() });
    // ── the other bug: the seller notification is never created here ──
    return { ok: true, title: l.title, order: "MK-" + Math.floor(1000 + Math.random() * 9000) };
  }

  /**
   * Buy the first available unit without knowing its id — one request, no lookup, so a
   * whole crowd can rush the same drop at the same instant. Same TOCTOU bug as buy(): the
   * "is it still available?" check and the "mark it sold" write straddle an async gap, so
   * every request that arrives during the gap passes the check and "wins" the one unit.
   * The gap is a stand-in for a slow inventory service / read-replica lag — the real-world
   * shape of a flash-sale oversell. With N concurrent racers, N of them get a confirmation.
   */
  async rush(buyer: string): Promise<{ ok: boolean; title?: string; order?: string }> {
    const l = this.listings.find((x) => !x.sold);
    if (!l) return { ok: false };
    await new Promise((r) => setTimeout(r, 150)); // the check-to-write window
    l.sold = true;
    l.buyer = buyer;
    this.sales.push({ id: l.id, title: l.title, seller: l.seller, buyer, at: Date.now() });
    return { ok: true, title: l.title, order: "MK-" + Math.floor(1000 + Math.random() * 9000) };
  }

  /** A sale happened but the seller was never notified — provable multi-user defect. */
  get sellerNeverNotified(): boolean {
    return this.sales.length > 0 && this.notifications.length === 0;
  }

  /** Listings that recorded more than one sale — a single unit sold to multiple buyers. */
  get oversold(): { title: string; buyers: string[] }[] {
    const byListing = new Map<string, string[]>();
    for (const s of this.sales) byListing.set(s.id, [...(byListing.get(s.id) ?? []), s.buyer]);
    return [...byListing.entries()]
      .filter(([, buyers]) => buyers.length > 1)
      .map(([id, buyers]) => ({ title: this.listings.find((l) => l.id === id)?.title ?? id, buyers }));
  }
}

/** Shared-document target. `save` REPLACES content (no merge) → concurrent edits are lost. */
class DocResource {
  content = "";
  saves: { who: string; text: string; at: number }[] = [];
  reset(): void {
    this.content = "";
    this.saves = [];
  }
  save(who: string, text: string): void {
    this.content = text; // last-writer-wins — the lost-update bug
    this.saves.push({ who, text, at: Date.now() });
  }
  /** Any editor whose saved text is not present in the final content — silently lost. */
  get lostEdits(): { who: string; text: string }[] {
    return this.saves.filter((s) => !this.content.includes(s.text));
  }
}

/** Chat target. `send` records the message on the sender's thread but never the recipient's. */
class ChatResource {
  threads = new Map<string, { text: string; mine: boolean }[]>();
  sent: { from: string; to: string; text: string }[] = [];
  reset(): void {
    this.threads.clear();
    this.sent = [];
  }
  private thread(who: string): { text: string; mine: boolean }[] {
    if (!this.threads.has(who)) this.threads.set(who, []);
    return this.threads.get(who)!;
  }
  send(from: string, _to: string, text: string): void {
    this.sent.push({ from, to: _to, text });
    this.thread(from).push({ text, mine: true }); // sender sees "delivered"
    // ── the bug: the recipient's thread is never written ──
  }
  messagesFor(who: string): { text: string; mine: boolean }[] {
    return this.thread(who);
  }
  /** A message was sent but the recipient's inbox stayed empty. */
  get undelivered(): { from: string; to: string; text: string }[] {
    return this.sent.filter((m) => this.thread(m.to).length === 0);
  }
}

export class ShoalServer {
  private http!: Server;
  private wss!: WebSocketServer;
  readonly race = new RaceResource();
  readonly market = new MarketplaceResource();
  readonly doc = new DocResource();
  readonly chat = new ChatResource();
  // Bounded state (not an event log) so 1000-agent swarms don't grow memory without limit.
  private config?: ShoalEvent;
  private states = new Map<string, ShoalEvent>();
  private thoughts: ShoalEvent[] = [];
  private findings: ShoalEvent[] = [];
  private handoffs: ShoalEvent[] = [];
  private cost?: ShoalEvent;
  private clusters?: ShoalEvent;
  private done?: ShoalEvent;
  private runState?: ShoalEvent;
  /** Set by the RunController; lets the dashboard drive the run lifecycle. */
  onControl?: (cmd: ControlCommand) => void;
  /**
   * The agent the operator is currently watching. Only featured agents and this one
   * stream screenshots, so clicking any fish gets you a live feed without paying to
   * push 1000 JPEGs down the socket.
   */
  focusedAgentId: string | null = null;

  async start(port: number): Promise<void> {
    this.http = createServer(async (req, res) => {
      const url = (req.url ?? "/").split("?")[0];
      let file: { body: Buffer; mime: string } | null = null;

      if (url === "/api/claim") {
        const buyer = new URL(req.url ?? "/", "http://x").searchParams.get("buyer") ?? "anon";
        const result = await this.race.claim(buyer);
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(result));
        return;
      }
      if (url === "/api/race-state") {
        res
          .writeHead(200, { "Content-Type": "application/json" })
          .end(JSON.stringify({ stock: this.race.stock, claims: this.race.claims, oversold: this.race.oversold }));
        return;
      }
      if (url === "/api/market/listings") {
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ listings: this.market.listings }));
        return;
      }
      if (url === "/api/market/my-sales") {
        // Reads the notification queue — empty by design, so the seller never sees the sale.
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ sales: this.market.notifications }));
        return;
      }
      if (url === "/api/market/list") {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
        const id = this.market.list(String(body.seller ?? "anon"), String(body.title ?? "item"), Number(body.price ?? 0));
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true, id }));
        return;
      }
      if (url === "/api/market/buy") {
        const q = new URL(req.url ?? "/", "http://x").searchParams;
        const result = await this.market.buy(q.get("id") ?? "", q.get("buyer") ?? "anon");
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(result));
        return;
      }
      if (url === "/api/market/rush") {
        const buyer = new URL(req.url ?? "/", "http://x").searchParams.get("buyer") ?? "anon";
        const result = await this.market.rush(buyer);
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(result));
        return;
      }
      if (url === "/api/doc") {
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ content: this.doc.content }));
        return;
      }
      if (url === "/api/doc/save") {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
        this.doc.save(String(body.who ?? "anon"), String(body.text ?? ""));
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true }));
        return;
      }
      if (url === "/api/chat") {
        const who = new URL(req.url ?? "/", "http://x").searchParams.get("who") ?? "anon";
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ messages: this.chat.messagesFor(who) }));
        return;
      }
      if (url === "/api/chat/send") {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
        this.chat.send(String(body.from ?? "anon"), String(body.to ?? "anon"), String(body.text ?? ""));
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true }));
        return;
      }

      if (url === "/shop" || url.startsWith("/shop/")) {
        const rel = url.replace(/^\/shop\/?/, "") || "index.html";
        file = await serveFile(BAIT_SHOP_DIR, rel);
      } else {
        const rel = url === "/" ? "index.html" : url.slice(1);
        file = (await serveFile(DASHBOARD_DIST, rel)) ?? (await serveFile(DASHBOARD_DIST, "index.html"));
      }

      if (!file) {
        res.writeHead(404).end("Not found");
        return;
      }
      res.writeHead(200, { "Content-Type": file.mime }).end(file.body);
    });

    this.wss = new WebSocketServer({ server: this.http, path: "/ws" });
    this.wss.on("connection", (socket) => {
      // Replay config + latest agent states + findings so late joiners see the wall.
      for (const ev of this.replayEvents()) socket.send(JSON.stringify(ev));
      // The same socket carries operator commands back (stop / restart).
      socket.on("message", (raw) => {
        try {
          const cmd = JSON.parse(String(raw)) as ControlCommand;
          if (cmd?.cmd === "focus") this.focusedAgentId = cmd.agentId;
          else if (cmd?.cmd === "stop" || cmd?.cmd === "restart") this.onControl?.(cmd);
        } catch {
          /* ignore malformed control frames */
        }
      });
    });

    // Large backlog: a flash-sale scene lands ~1000 connections in the same instant, and the
    // OS accept queue (default ~511) would otherwise refuse the overflow with ECONNREFUSED.
    await new Promise<void>((resolve) => this.http.listen(port, undefined, 2048, resolve));
  }

  private replayEvents(): ShoalEvent[] {
    return [
      ...(this.config ? [this.config] : []),
      ...(this.runState ? [this.runState] : []),
      ...this.states.values(),
      ...this.thoughts.slice(-40),
      ...this.handoffs,
      ...this.findings,
      ...(this.cost ? [this.cost] : []),
      ...(this.clusters ? [this.clusters] : []),
      ...(this.done ? [this.done] : []),
    ];
  }

  /** Clear per-run state (kept: nothing) so a restart shows a fresh wall. */
  resetRunState(): void {
    this.states.clear();
    this.thoughts = [];
    this.findings = [];
    this.handoffs = [];
    this.cost = undefined;
    this.clusters = undefined;
    this.done = undefined;
    this.race.reset();
    this.broadcast({ type: "run_reset" });
  }

  broadcast(event: ShoalEvent): void {
    if (event.type === "run_config") this.config = event;
    else if (event.type === "agent_state") this.states.set(event.state.agentId, event);
    else if (event.type === "agent_batch") {
      for (const s of event.states) {
        this.states.set(s.agentId, { type: "agent_state", state: s, ts: event.ts });
      }
    }
    else if (event.type === "thought") {
      this.thoughts.push(event);
      if (this.thoughts.length > 200) this.thoughts.shift();
    } else if (event.type === "finding") this.findings.push(event);
    else if (event.type === "handoff") this.handoffs.push(event);
    else if (event.type === "cost") this.cost = event;
    else if (event.type === "clusters") this.clusters = event;
    else if (event.type === "run_state") this.runState = event;
    else if (event.type === "run_done") this.done = event;
    const payload = JSON.stringify(event);
    for (const client of this.wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(payload);
    }
  }

  async stop(): Promise<void> {
    this.wss?.close();
    await new Promise<void>((resolve) => this.http.close(() => resolve()));
  }
}
