import type { Finding, Persona } from "./types.js";
import { loadPersonas } from "./personas.js";

/**
 * Scenes = multi-user tests.
 *
 * Every other mode tests ONE user at a time. A scene casts several agents in ROLES that
 * interact through the product. The bug a scene finds is a *mismatch between agents* — the
 * buyer's purchase the seller never sees, one editor's work another silently overwrites, a
 * message that's sent but never delivered — which no single-user test can surface.
 *
 * A role can be a single coordinator (the one seller) or a whole CROWD (a thousand buyers
 * racing for one item). Crowd roles scale with --swarm and run in memory-safe waves, so a
 * scene can put a coordinator in front of up to ~1000 interacting participants.
 */

export interface SceneStep {
  think?: string;
  click?: string;
  type?: [string, string];
  /** Announce an event to the other agents, optionally with a note (shared blackboard). */
  signal?: { event: string; note?: string };
  /** Block until another agent signals this event. */
  awaitEvent?: string;
  pause?: number;
  finding?: Omit<Finding, "agentId" | "personaName" | "ts">;
  end?: { outcome: "completed" | "gave_up"; reason: string };
}

export interface SceneRole {
  id: string; // "seller" | "buyer" | ...
  label: string;
  persona: string;
  path: string; // page this role loads (query string picks the view)
  task: string; // LLM-mode task
  script: SceneStep[]; // mock-mode flow
  /** Fixed number of this role. Default 1. */
  count?: number;
  /** If true, --swarm sets how many of this role there are (the crowd). */
  scalable?: boolean;
  /**
   * Run this role as a lightweight concurrent client (one real HTTP request against the
   * live server) instead of a full vision-driven browser. This is what lets a crowd role
   * scale to ~1000 truly-simultaneous participants: proving a server-side race needs
   * concurrency, not a thousand browsers. `rush` names the single action it fires.
   */
  browserless?: boolean;
  rush?: "market";
}

export interface Scene {
  id: string;
  name: string;
  summary: string;
  roles: SceneRole[];
}

/** One concrete agent in a running scene: which role, which copy of it. */
export interface SceneInstance {
  role: SceneRole;
  persona: Persona;
  copy: number; // 0-based index within the role
}

// ── Marketplace: seller ↔ buyer, the notification bug ──────────────────────────
const MARKETPLACE: Scene = {
  id: "marketplace",
  name: "Marketplace: seller ↔ buyer",
  summary: "A seller lists an item and a buyer purchases it — do both sides agree it happened?",
  roles: [
    {
      id: "seller",
      label: "Seller",
      persona: "careful-carl",
      path: "/shop/market.html?role=seller",
      task:
        "You are a SELLER. List an item for sale, then signal 'listed'. Wait for the buyer to purchase " +
        "it, then check your sales dashboard to confirm you were notified.",
      script: [
        { think: "I'll list my Blue Kayak for sale.", pause: 700 },
        { type: ["#item-title", "Blue Kayak"], pause: 400 },
        { type: ["#item-price", "50"], pause: 400 },
        { click: "#list-btn", think: "Listed it. Telling the buyer it's up.", pause: 700 },
        { signal: { event: "listed", note: "Blue Kayak for $50" } },
        { think: "Now I'll wait for someone to buy it, then check my sales.", awaitEvent: "purchased", pause: 500 },
        { click: "#refresh-sales", think: "The buyer says they bought it — let me check my dashboard.", pause: 1000 },
        { click: "#refresh-sales", think: "Still nothing? Let me refresh again.", pause: 1000 },
        {
          finding: {
            severity: "high",
            title: "Seller never notified of a completed sale",
            description:
              "The buyer completed a purchase of my Blue Kayak and got a confirmation — but my seller " +
              "dashboard still says 'No sales yet.' I was never told my item sold, so I'd never ship it.",
          },
          think: "This is broken. My kayak sold and my own dashboard doesn't know.",
          pause: 600,
        },
        { end: { outcome: "completed", reason: "Listed and it sold — but I was never notified." } },
      ],
    },
    {
      id: "buyer",
      label: "Buyer",
      persona: "speedrun-sam",
      path: "/shop/market.html?role=buyer",
      task: "You are a BUYER. Wait for 'listed', find the item, buy it, then signal 'purchased'.",
      script: [
        { think: "Waiting for the seller to list something.", awaitEvent: "listed", pause: 400 },
        { think: "Something's listed. Refreshing.", click: "#refresh-listings", pause: 800 },
        { think: "There's the Blue Kayak. Buying it.", click: ".buy-btn", pause: 1100 },
        { think: "Bought! Telling the seller.", pause: 400 },
        { signal: { event: "purchased", note: "bought the Blue Kayak" } },
        { end: { outcome: "completed", reason: "Bought the kayak, got a confirmation." } },
      ],
    },
  ],
};

// ── Flash sale: 1 seller ↔ a CROWD of buyers racing one unit (scales to 1k) ─────
const FLASH_SALE: Scene = {
  id: "flash-sale",
  name: "Flash sale: 1 item, a crowd of buyers",
  summary: "One seller lists a single unit; hundreds of buyers rush it at once. Does exactly one win?",
  roles: [
    {
      id: "seller",
      label: "Seller",
      persona: "careful-carl",
      path: "/shop/market.html?role=seller",
      task: "List ONE unit for sale, then signal 'sale-open' so the crowd can rush it.",
      script: [
        { think: "Dropping one Abyss Duffel for the flash sale.", pause: 500 },
        { type: ["#item-title", "Abyss Duffel"], pause: 300 },
        { type: ["#item-price", "120"], pause: 300 },
        { click: "#list-btn", think: "Listed. Opening the sale to everyone.", pause: 500 },
        { signal: { event: "sale-open", note: "1x Abyss Duffel — go!" } },
        { end: { outcome: "completed", reason: "One unit listed, sale opened to the crowd." } },
      ],
    },
    {
      id: "buyer",
      label: "Buyer",
      persona: "speedrun-sam",
      scalable: true, // --swarm sets how many
      browserless: true, // a crowd of concurrent clients, not a crowd of browsers → scales to ~1000
      rush: "market",
      path: "/shop/market.html?role=buyer",
      task: "Wait for 'sale-open', then race everyone else to buy the single unit before it's gone.",
      // Ghost racers await this event, then all fire one buy at the same instant.
      script: [{ awaitEvent: "sale-open" }],
    },
  ],
};

// ── Collaborative doc: two editors, the lost update ────────────────────────────
const COLLAB_DOC: Scene = {
  id: "collab-doc",
  name: "Shared doc: two editors at once",
  summary: "Two people edit the same document simultaneously — do both edits survive?",
  roles: [
    {
      id: "editor-a",
      label: "Editor A",
      persona: "careful-carl",
      path: "/shop/doc.html?who=Ada",
      task:
        "You are editing a shared doc with someone else at the same time. Write your section, coordinate " +
        "via signals so you both save, then check that BOTH of your edits survived.",
      script: [
        { think: "Opening the shared doc. I'll add the intro.", pause: 700 },
        { type: ["#doc", "Intro, written by Ada."], pause: 500 },
        { signal: { event: "a-ready", note: "Ada wrote the intro" }, think: "Ready. Waiting for my co-editor." },
        { awaitEvent: "b-ready", pause: 300 },
        { click: "#save-btn", think: "Saving my intro.", pause: 700 },
        { signal: { event: "a-saved" } },
        { awaitEvent: "b-saved", think: "They've saved too. Let me refresh and read the whole doc.", pause: 500 },
        { click: "#reload-btn", pause: 900 },
        {
          finding: {
            severity: "high",
            title: "Concurrent edit silently lost (lost update)",
            description:
              "My co-editor and I edited the shared doc at the same time. After we both saved, my intro is " +
              "gone — only their section remains. My work was silently overwritten with no warning or merge.",
          },
          think: "My intro vanished. Their save wiped mine and nothing warned either of us.",
          pause: 500,
        },
        { end: { outcome: "completed", reason: "Both saved — but only one edit survived." } },
      ],
    },
    {
      id: "editor-b",
      label: "Editor B",
      persona: "chaos-cathy",
      path: "/shop/doc.html?who=Ben",
      task: "Edit the same doc as your co-editor, coordinate via signals, save your section.",
      script: [
        { think: "I've got the same doc open. Adding my summary.", pause: 700 },
        { type: ["#doc", "Summary, written by Ben."], pause: 500 },
        { signal: { event: "b-ready", note: "Ben wrote the summary" }, think: "Ready." },
        { awaitEvent: "a-ready", pause: 300 },
        { awaitEvent: "a-saved", think: "They saved first. Now I'll save mine.", pause: 400 },
        { click: "#save-btn", think: "Saving my summary.", pause: 700 },
        { signal: { event: "b-saved" } },
        { end: { outcome: "completed", reason: "Saved my summary." } },
      ],
    },
  ],
};

// ── Chat: a message that's sent but never delivered ────────────────────────────
const CHAT: Scene = {
  id: "chat",
  name: "Chat: sender ↔ recipient",
  summary: "One user sends a message; does the other user actually receive it?",
  roles: [
    {
      id: "sender",
      label: "Sender",
      persona: "speedrun-sam",
      path: "/shop/chat.html?who=Sam",
      task: "Send a chat message to the other user, then signal 'sent'.",
      script: [
        { think: "Messaging Riley about the meetup.", pause: 600 },
        { type: ["#msg", "Hey Riley — 3pm still good?"], pause: 500 },
        { click: "#send-btn", think: "Sent. It shows in my thread.", pause: 700 },
        { signal: { event: "sent", note: "Hey Riley — 3pm still good?" } },
        { end: { outcome: "completed", reason: "Sent the message; my side shows it delivered." } },
      ],
    },
    {
      id: "recipient",
      label: "Recipient",
      persona: "distracted-dee",
      path: "/shop/chat.html?who=Riley",
      task: "Wait for the other user to send a message, then check whether it actually arrived in your inbox.",
      script: [
        { think: "Waiting to hear from Sam.", awaitEvent: "sent", pause: 400 },
        { click: "#refresh-btn", think: "Sam says they messaged me. Checking my inbox.", pause: 900 },
        { click: "#refresh-btn", think: "Nothing here. Refreshing again.", pause: 900 },
        {
          finding: {
            severity: "high",
            title: "Sent message never delivered to the recipient",
            description:
              "The other user sent me a message and their thread shows it delivered — but my inbox is empty. " +
              "The message was accepted on the sender's side but never reached mine.",
          },
          think: "Their app says delivered. My inbox is empty. The message vanished in between.",
          pause: 500,
        },
        { end: { outcome: "completed", reason: "They sent it, I never got it." } },
      ],
    },
  ],
};

const SCENES: Record<string, Scene> = {
  marketplace: MARKETPLACE,
  "flash-sale": FLASH_SALE,
  "collab-doc": COLLAB_DOC,
  chat: CHAT,
};

export function getScene(id: string): Scene {
  const s = SCENES[id];
  if (!s) throw new Error(`Unknown scene "${id}". Available: ${Object.keys(SCENES).join(", ")}`);
  return s;
}

export function listScenes(): Scene[] {
  return Object.values(SCENES);
}

/**
 * Expand a scene's roles into concrete agent instances. `size` sets how many of the
 * scalable (crowd) role there are; fixed roles use their `count` (default 1). Coordinators
 * come FIRST so they always get an execution slot before the crowd that waits on them.
 */
export function expandRoles(scene: Scene, size?: number): SceneInstance[] {
  const lib = loadPersonas();
  const personaFor = (id: string) => lib.find((p) => p.id === id) ?? lib[0];
  const fixed: SceneInstance[] = [];
  const crowd: SceneInstance[] = [];
  for (const role of scene.roles) {
    const n = role.scalable ? Math.max(1, size ?? 20) : role.count ?? 1;
    const bucket = role.scalable ? crowd : fixed;
    for (let i = 0; i < n; i++) bucket.push({ role, persona: personaFor(role.persona), copy: i });
  }
  return [...fixed, ...crowd];
}

/** True if this scene has a crowd role (and therefore scales with --swarm). */
export function sceneScales(scene: Scene): boolean {
  return scene.roles.some((r) => r.scalable);
}
