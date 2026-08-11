// Retake README screenshots against the live dashboard (new ink-on-paper UI).
import { spawn, execSync } from "node:child_process";
import { chromium } from "playwright";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OUT = "docs/images";

async function withRun(args, port, fn) {
  const child = spawn("node", ["packages/core/dist/cli.js", "demo", ...args, "--port", String(port), "--no-open"], {
    stdio: "ignore",
  });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1680, height: 1000 } });
  try {
    // Wait for the server, then load the dashboard.
    for (let i = 0; i < 30; i++) {
      try {
        await page.goto(`http://localhost:${port}`, { waitUntil: "domcontentloaded", timeout: 3000 });
        break;
      } catch {
        await sleep(1000);
      }
    }
    await fn(page);
  } finally {
    await browser.close();
    try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: "ignore" }); } catch {}
    await sleep(2000);
  }
}

// ── Run A: the 1000-fish tank ──
console.log("run A: swarm 1000…");
await withRun(["--swarm", "1000"], 4901, async (page) => {
  await page.waitForSelector(".aquarium", { timeout: 30000 });
  await sleep(75000); // let the funnel develop: depth spread, gold sinkers, friction map
  await page.screenshot({ path: `${OUT}/aquarium-1000.png` });
  console.log("  aquarium-1000.png");

  // Drill-down: click into the water until a fish is selected.
  const box = await (await page.$(".aquarium")).boundingBox();
  for (const [fx, fy] of [[0.45, 0.5], [0.55, 0.45], [0.5, 0.6], [0.4, 0.4]]) {
    await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy);
    await sleep(800);
    if (await page.$(".drilldown")) break;
  }
  await sleep(4000); // focused fish starts streaming on its next step
  await page.screenshot({ path: `${OUT}/aquarium-drilldown.png` });
  console.log("  aquarium-drilldown.png");
  const close = await page.$(".dd-close");
  if (close) await close.click();
});

// ── Run B: classic 8-agent camera wall ──
console.log("run B: swarm 8 cams…");
await withRun(["--swarm", "8"], 4902, async (page) => {
  await page.waitForSelector(".aquarium", { timeout: 30000 });
  await page.click(".view-toggle button:last-child");
  await sleep(30000); // mid-run: thoughts under viewports, some confusion flashes
  await page.screenshot({ path: `${OUT}/dashboard-camera-wall.png` });
  console.log("  dashboard-camera-wall.png");
});

// ── Run C: race mode ──
console.log("run C: race…");
await withRun(["--swarm", "5", "--race"], 4903, async (page) => {
  await page.waitForSelector(".aquarium", { timeout: 30000 });
  await page.click(".view-toggle button:last-child");
  await sleep(26000); // after the barrier strike — confirmations + oracle finding
  await page.screenshot({ path: `${OUT}/dashboard-race-mode.png` });
  console.log("  dashboard-race-mode.png");
});

// ── Run D: marketplace scene (auto-switches to side-by-side wall) ──
console.log("run D: scene…");
await withRun(["--scene", "marketplace"], 4904, async (page) => {
  await page.waitForSelector(".wall, .aquarium", { timeout: 30000 });
  await sleep(19000); // mid-handoff: seller listed, buyer buying
  await page.screenshot({ path: `${OUT}/scene-marketplace.png` });
  console.log("  scene-marketplace.png");
});

console.log("all shots done");
process.exit(0);
