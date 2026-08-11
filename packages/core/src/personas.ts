import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parse } from "yaml";
import type { Persona } from "./types.js";

const here = dirname(fileURLToPath(import.meta.url));

export function loadPersonas(): Persona[] {
  const raw = readFileSync(join(here, "..", "personas", "personas.yaml"), "utf8");
  const doc = parse(raw) as { personas: Persona[] };
  return doc.personas;
}

/** Pick `n` personas, cycling through the library (and filtering to `ids` when given). */
export function pickPersonas(n: number, ids?: string[]): Persona[] {
  let pool = loadPersonas();
  if (ids && ids.length > 0) {
    pool = pool.filter((p) => ids.includes(p.id));
    if (pool.length === 0) throw new Error(`No personas matched: ${ids.join(", ")}`);
  }
  return Array.from({ length: n }, (_, i) => pool[i % pool.length]);
}

/**
 * Fill `n` swarm slots from a (possibly small) persona pool. Uses each distinct persona
 * at least once, then weight-samples the remainder — so a generated panel's real-audience
 * distribution is honored when the swarm is larger than the panel.
 */
export function fillFromPool(pool: Persona[], n: number): Persona[] {
  if (pool.length === 0) throw new Error("empty persona pool");
  if (pool.length >= n) return pool.slice(0, n);
  const out = [...pool];
  const totalWeight = pool.reduce((s, p) => s + (p.weight ?? 1), 0);
  while (out.length < n) {
    let r = Math.random() * totalWeight;
    let pick = pool[pool.length - 1];
    for (const p of pool) {
      r -= p.weight ?? 1;
      if (r <= 0) {
        pick = p;
        break;
      }
    }
    out.push(pick);
  }
  return out;
}
