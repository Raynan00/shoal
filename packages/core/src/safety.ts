import { createInterface } from "node:readline/promises";

/**
 * Shoal points a swarm of browsers at a URL and hammers it. That is fine against your own
 * dev preview and abusive against someone else's site — and the risk grows with `--swarm`
 * and with agent-initiated runs over MCP. This gate makes the target an explicit decision.
 *
 * Local targets pass silently. Anything else must be allowlisted (--allow-domain), waved
 * through (--yes), or confirmed interactively.
 */

const LOCAL = new Set(["localhost", "127.0.0.1", "0.0.0.0", "[::1]", "::1"]);

export function isLocalTarget(url: string): boolean {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return (
      LOCAL.has(h) ||
      h.endsWith(".local") ||
      h.endsWith(".localhost") ||
      h.endsWith(".test") ||
      /^10\./.test(h) ||
      /^192\.168\./.test(h) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(h)
    );
  } catch {
    return false;
  }
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/** Non-interactive check — used by the MCP server, which must never block on a prompt. */
export function isTargetAllowed(url: string, allow: string[] = []): boolean {
  if (isLocalTarget(url)) return true;
  const host = hostOf(url);
  return allow.some((d) => {
    const dd = d.toLowerCase().replace(/^\*\./, "");
    return host === dd || host.endsWith(`.${dd}`);
  });
}

/**
 * Interactive gate for the CLI. Returns true if the run may proceed.
 * `--yes` (or a non-TTY, e.g. CI) skips the prompt only when the domain is allowlisted.
 */
export async function confirmTarget(
  url: string,
  opts: { allow?: string[]; yes?: boolean; swarm: number },
): Promise<boolean> {
  if (isTargetAllowed(url, opts.allow)) return true;

  const host = hostOf(url);
  console.log(`\n  ⚠️  Target is not local: ${host}`);
  console.log(`     You are about to send ${opts.swarm} automated browser agents at it.`);
  console.log(`     Only do this against sites you own or are authorised to test.`);

  if (opts.yes) {
    console.log(`     --yes given → proceeding.\n`);
    return true;
  }
  if (!process.stdin.isTTY) {
    console.error(
      `     Refusing to run non-interactively against a public host.\n` +
        `     Pass --allow-domain ${host} (or --yes) if you are authorised.\n`,
    );
    return false;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`     Type the hostname to confirm: `)).trim().toLowerCase();
  rl.close();
  if (answer !== host) {
    console.error("     Did not match — aborting.\n");
    return false;
  }
  console.log("");
  return true;
}
