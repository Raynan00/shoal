import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Reads the Claude Code / Pro-Max subscription token so the swarm can run on the
 * developer's existing subscription instead of a metered API key.
 *
 * The token rotates every few hours, so this is read LIVE (per agent start), never
 * cached — Claude Code keeps the file refreshed while it's in use. The swarm draws on
 * the same rate pool as the developer's own Claude Code usage, which is why
 * subscription mode runs at low concurrency with patient retries (see cli.ts).
 */

export interface SubCreds {
  token: string;
  subscriptionType: string; // "max" | "pro" | ...
  tier: string; // e.g. "default_claude_max_5x"
  expiresAt: number;
}

const CREDS_PATH = join(homedir(), ".claude", ".credentials.json");

export function readSubscriptionCreds(): SubCreds {
  let raw: string;
  try {
    raw = readFileSync(CREDS_PATH, "utf8");
  } catch {
    throw new Error(
      `No Claude Code credentials at ${CREDS_PATH}. ` +
        `Log in to Claude Code first (it uses your Pro/Max subscription), or use --provider anthropic with an API key.`,
    );
  }

  const oauth = JSON.parse(raw)?.claudeAiOauth;
  if (!oauth?.accessToken) {
    throw new Error(
      "Claude Code credentials found, but no subscription token in them. " +
        "If you logged in with an API key, use --provider anthropic instead.",
    );
  }
  if (typeof oauth.expiresAt === "number" && oauth.expiresAt < Date.now()) {
    throw new Error(
      "Your Claude Code subscription token has expired. " +
        "Run any Claude Code command (or /login) to refresh it, then retry shoal.",
    );
  }

  return {
    token: oauth.accessToken,
    subscriptionType: oauth.subscriptionType ?? "unknown",
    tier: oauth.rateLimitTier ?? "unknown",
    expiresAt: oauth.expiresAt ?? 0,
  };
}

/** True if Claude Code subscription creds are present and unexpired (for CLI preflight). */
export function hasSubscription(): boolean {
  try {
    readSubscriptionCreds();
    return true;
  } catch {
    return false;
  }
}
