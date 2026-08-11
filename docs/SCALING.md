# Running 1,000 browser sessions on one machine

Shoal runs a swarm of AI agents, each driving its own Chromium session and deciding what
to click from a screenshot. The obvious problem: a thousand browsers do not fit in 32 GB
of RAM.

This is what I found while trying anyway. Everything below is measured on a laptop, not a
server, unless it cites a paper or a vendor.

## Nobody actually runs 1,000 rendering browsers on one box

I went looking for prior art first. Every published number lands in the same place.

| Source | Density | Hardware |
|---|---|---|
| Browserless (5M sessions/week) | ~10 sessions per GB of RAM, RAM-bound not CPU-bound | fleet of small nodes |
| WebGym (arXiv:2601.02439) | ~2 browsers per CPU core | 64 to 768 EPYC cores |
| WEBSERV (arXiv:2510.16252) | 200+ full environments | 128 vCPU, 1 TB RAM |
| Playwright idle floor | 590 to 700 MB including the driver | datawookie.dev measurement |

Typical per-session cost in production writeups is 250 to 500 MB. Every service
advertising 10,000 concurrent sessions gets there horizontally, across a fleet, not on one
machine.

So the interesting question is not "how do I make a browser smaller". It is "how many
browsers actually need to be running at any given instant".

## An agent waiting on a model does not need a CPU

A vision agent spends most of its life blocked: waiting for the model to answer, waiting
on a scripted pause, waiting for another agent in a multi-user scene. During that time its
page is rendering nothing anyone will look at.

Chromium can freeze a page outright. `Page.setWebLifecycleState('frozen')` over CDP stops
JavaScript, timers and rendering while keeping the page's full state in memory, and it
thaws instantly. It is the same mechanism behind Chrome's Energy Saver and Edge's sleeping
tabs.

That splits one number into two, which turn out to be bound by different resources:

* **Resident**: agents holding a live browser context. Memory-bound.
* **Active**: agents unfrozen and actually rendering right now. CPU-bound.

Shoal sizes them separately. An agent takes an active slot for the few hundred
milliseconds it needs to act and capture a frame, then freezes and gives the slot back.
Hundreds can be resident while a few dozen render.

I did not invent this. It is the same shape everything that scales converges on:

* WebGym removed sync barriers between environment steps and got 4 to 5x the rollout
  throughput.
* OASIS (arXiv:2411.11581) simulates a million agents by only giving model calls to the
  ones that are active on a given tick.
* Project Sid (arXiv:2411.00114) runs cheap loops continuously and expensive model
  cognition sparsely.
* Kernel and browser-use's cloud park idle browser sessions as microVM snapshots and
  restore them on demand, reported at 20 ms to 3 s.

Microsoft has the strongest public evidence that freezing works, from Edge's sleeping
tabs: about 83 to 85% memory and 99% CPU saved per slept tab, measured across roughly
13,000 devices.

## What it cost per agent

Same machine, same 100-agent swarm, zero errors each time. Test bed is a Windows 11
laptop, 32 GB and 24 cores.

| Configuration | Peak Chromium memory | Per resident agent |
|---|---|---|
| Baseline | | ~100 MB |
| Process-model flags + freeze tier | 4.0 GB | 72 MB |
| Skipping frames nobody is watching | 3.3 GB | **57 MB** |

The last row is worth explaining. In a large swarm only a dozen agents stream video to the
dashboard, plus whichever one you have clicked on. Every other agent was rendering and
JPEG-encoding frames that got dropped before they hit the socket. Now they skip the
unfreeze, render and encode entirely, not just the upload.

57 MB per agent against a published norm of 250 to 500 MB. All of it is repo code, so a
fresh clone reproduces it with no host tuning and no admin rights.

That per-agent number is the part that travels, and it is why the machine matters less
than you would expect. At 57 MB, a 16 GB laptop holds around 100 resident agents and a
32 GB one around 200. Neither is remotely close to 1,000. Buying a bigger machine moves
this number linearly and slowly; the scheduling in the previous section is what actually
gets a run to 1,000, and it works the same on a small laptop.

## The thing I could not find published anywhere

**One browser process creates contexts at about 1.0 per second, no matter how many you
ask for in parallel.**

I hit this while wondering why a 1,000-agent run only ever showed 10 to 15 agents
swimming. Concurrency was set far higher and memory was nowhere near the limit.

Measuring it directly: 30 context-and-page creations requested in parallel took 28.8
seconds, exactly the same as doing 30 one after another. The cost is renderer process
spawn, roughly 1 to 3 seconds each, and it funnels through the single browser process.

That launch-starves a swarm. In-flight agents settle at launch rate multiplied by session
length, and no amount of extra concurrency changes it.

The fix is a small pool of browser processes rather than one, with contexts spread across
them. Four shards measured 3.6 launches per second, close to linear. After sharding,
in-flight count pinned at full concurrency: 45 to 48 out of 48, against 10 to 15 before.
Contexts stay fully isolated per agent, the shards only spread the spawn work.

If you run browser fleets and size your pool by memory alone, this is probably costing you
throughput you have not noticed.

## Flags: what moved the needle and what didn't

Helped:

* `--process-per-site` with site isolation disabled. Chromium documents site isolation at
  10 to 13% total memory overhead, and per-iframe processes multiply it. A swarm points
  every agent at one site, so renderer count collapses toward the number of distinct
  sites.
* Modest viewports. Raster tile memory scales with viewport area, so 1280x800 at scale
  factor 1 roughly halves it versus 1080p. One production report had a single 8K
  screenshot spike 2 GB.
* Recycling browser processes on a timer. Two independent fleets landed on about an hour;
  Chromium drifts to ~1.5 GB by hour eight otherwise.
* V8 heap caps per renderer, so a runaway page crashes itself instead of the machine.

Did not help, despite being widely recommended:

* `--single-process` measurably *increases* memory, around 250 MB versus 46 MB.
* Stacking the usual flag lists past the basics saved about 16 MB in a controlled test.
* `--blink-settings=imagesEnabled=false` has a memory-growth bug in headless, and removes
  images from screenshots, which defeats the point for a vision agent.
* `--disable-dev-shm-usage` is a Linux and Docker fix. It does nothing on Windows.
* Lightweight browser engines like Lightpanda are genuinely 9 to 11x lighter, but they do
  not rasterize at all. No pixels, no vision agent.

One trap worth knowing: Playwright's `route()` silently disables the HTTP cache. Block
trackers through CDP `Network.setBlockedURLs` instead and keep the cache.

## Windows specifics

Almost all the density literature is Linux. A few things only bite on Windows.

**Commit charge is the real ceiling, not RAM.** Windows has no OOM killer. Allocations
simply fail once you hit the commit limit, which is RAM plus pagefile, and Chromium turns
a failed allocation into a process crash. If that lands in the browser process it takes
every session with it. Chromium's allocator commits considerably more than it touches, so
a fleet can die of commit exhaustion with gigabytes of physical RAM still free. A large
fixed pagefile costs nothing but disk and raises the ceiling.

Already on by default and worth leaving alone: memory compression (Windows 11's answer to
zram, roughly 30 to 50% per page), and automatic timer-resolution coarsening for invisible
processes, which headless Chromium qualifies for.

Worth doing: Defender exclusions, or a Dev Drive, for the Playwright browser cache and
temp profiles. Windows process creation benchmarks more than 20x slower than Linux and a
large share of that is the AV filter stack, which taxes every renderer spawn.

Not worth it: page combining (off by default, 15-minute scan cycles, roughly 4x
copy-on-write penalty on first write to a merged page), forced working-set trimming
(measured 12x slowdown re-touching trimmed memory, and it does nothing for commit charge),
RAM disks for profiles (spends the exact memory the sessions need), and `--no-sandbox`
(no measured Windows win, real security cost).

There is also a genuine ecosystem gap: no maintained npm package wraps Windows Job
Objects, which is the correct way to guarantee a browser process tree dies with its
parent. Playwright resorts to `taskkill /T`, which is racy.

## Linux, if you are deploying rather than developing

| Technique | Gain | Effort |
|---|---|---|
| KSM page dedup, one `prctl` call since kernel 6.4 | 9 to 50% on identical-process fleets | one line |
| zram with zstd | 1.3 to 1.5x effective RAM | low |
| cgroups v2 `memory.high` plus PSI admission | a real "is the machine full" signal instead of free-RAM guessing | medium |
| CRIU or Firecracker snapshot parking | parked sessions cost ~0 RAM, 200 ms to 3 s restore | high |

Two warnings. Use `cpu.weight` rather than `cpu.max`: hard quotas cause multi-millisecond
stalls for bursty multi-threaded processes, and Chrome is extremely multi-threaded. And
nobody has published a KSM dedup ratio for a Chromium fleet, which is a shame, because a
swarm of identical binaries with identical V8 snapshots all pointed at the same site is
close to the ideal case for it.

## The model side

Browsers are only half the cost of a large swarm.

Shoal's agents share about 90% of their prompt, since the system prompt and tool
definitions are identical across the swarm. Anthropic bills cached reads at 10% of input
price, which puts effective input cost near 19% of naive, and removes most of the
time-to-first-token. Self-hosted, SGLang's RadixAttention reports up to 6.4x throughput on
exactly this shape of workload.

Screenshot size has a measured accuracy curve, and it is not monotonic in the way you
might assume. Grounding accuracy plateaus around 2,000 image tokens (Phi-Ground).
Instruction-aware token selection keeps about 97% of accuracy at 30% of the tokens
(FocusUI). Cropping and then grounding beats full resolution outright (UI-AGILE moved
31.6 to 56.0 on ScreenSpot-Pro). But naive downscaling of a dense UI collapses accuracy.
The lever is a smaller viewport and crops, never shrinking a large screenshot.

## Where the ceiling actually is

| Setup | Rendering at once | Resident | Agents in a run |
|---|---|---|---|
| 16 GB laptop, 8 cores | ~16 | ~100 | ~1,000 in waves |
| 32 GB laptop, 24 cores | 30 to 60 | 150 to 250 | ~1,000 |
| Linux server with KSM, zram and snapshot parking | CPU-bound | 300+ | 1,000+ parked and resumable |
| Anyone, 1,000 rasterizing in the same instant | not published by any source I found | | |

So: 1,000 agents in a run on one laptop, yes, and on a fairly ordinary one. 1,000 browsers
all rasterizing in the same instant, no, and I have not found anyone who can.

Shoal is explicit about the split. Crowd roles in the flash-sale scene are genuinely
simultaneous because they issue requests rather than render. Vision agents run in waves,
and the freeze tier moves the wave boundary from whole agents down to individual steps,
which is what raises the effective number without giving up pixel fidelity.

## Sources

* Browserless engineering blog, 5M sessions per week observations
* Chromium process model and site isolation docs, chromium.org
* Page lifecycle freezing, developer.chrome.com/blog/freezing-on-energy-saver
* Edge sleeping tabs telemetry, blogs.windows.com/msedgedev
* WEBSERV (arXiv:2510.16252), WebGym (arXiv:2601.02439), Weblica (arXiv:2605.06761)
* OASIS (arXiv:2411.11581), AgentScope (arXiv:2407.17789), Project Sid (arXiv:2411.00114)
* SGLang RadixAttention (arXiv:2312.07104), Parrot (OSDI'24), vLLM (SOSP'23)
* FocusUI (arXiv:2601.03928), Phi-Ground (arXiv:2507.23779), UI-AGILE (arXiv:2507.22025),
  ScreenSpot-Pro (ACM MM'25)
* KSM docs at docs.kernel.org plus Meta's LPC'23 numbers, Firecracker (NSDI'20),
  DeltaBox (arXiv:2605.22781)
* kernel.sh and browser-use.com engineering posts
