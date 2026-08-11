import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parse } from "yaml";
import type { Strategy } from "./types.js";

const here = dirname(fileURLToPath(import.meta.url));

export function loadStrategies(): Strategy[] {
  const raw = readFileSync(join(here, "..", "strategies", "strategies.yaml"), "utf8");
  return (parse(raw) as { strategies: Strategy[] }).strategies;
}

export function getStrategy(id: string): Strategy {
  const found = loadStrategies().find((s) => s.id === id);
  if (!found) {
    throw new Error(
      `Unknown strategy "${id}". Available: ${loadStrategies().map((s) => s.id).join(", ")}`,
    );
  }
  return found;
}

/** Assign strategies across the swarm, cycling so every slot gets one. */
export function assignStrategies(n: number, ids?: string[]): Strategy[] {
  const pool = ids && ids.length > 0 ? ids.map(getStrategy) : [getStrategy("complete-task")];
  return Array.from({ length: n }, (_, i) => pool[i % pool.length]);
}
