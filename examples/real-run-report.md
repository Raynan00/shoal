# A real run — unedited output

This is the actual report from a **real LLM swarm**, not the scripted demo. Four agents
each drove their own Chromium browser through a Claude computer-use loop — screenshot →
decide → act — and filed findings in their own words.

```bash
shoal run http://localhost:4321/shop --swarm 4 --model claude-haiku-4-5
```

The target is the bundled bait shop, deliberately: its bugs are *planted*, so you can
verify the agents found a real one rather than taking anyone's word for it. The winner
here — "Continue to checkout ignores the first clicks" — is trap #1 in the README.

Worth noting in the output below:

- **Two agents independently hit the same wall**, and clustering collapsed their two
  reports into one ranked issue (reach 2/4). That ranking is the friction map.
- **The verify pass confirmed both** — a second model checked each finding against the
  agent's action trail, and neither was an artifact.
- **One agent gave up** and one completed checkout with a partly-empty form. Real runs
  are not tidy.
- **$0.64 total**, metered live: $0.16 per agent-session on Haiku.

Findings are the agents' own text, warts and all — nothing here was written by a human.

---

# 🐟 Shoal swarm report

- **Target:** http://localhost:4931/shop
- **Task:** Buy any product and complete checkout.
- **Swarm:** 4 agents (claude-haiku-4-5)
- **Outcome:** 3 completed · 1 gave up · 0 errored
- **Cost:** $0.64 total · $0.160 per agent-session (513k tokens on claude-haiku-4-5)

### What this token volume costs per tier

*Rough estimate: same token counts priced at each tier's rates (tokenizers differ across models).*

| Tier | Cost |
|---|---|
| claude-opus-5 | $3.20 |
| claude-haiku-4-5 | $0.64 |
| qwen3-vl-plus (est.) | $0.13 |
| local model (Ollama) | $0.00 |

## Findings (1 issues, 2 reports; verify pass: 2 confirmed, 0 suspect)

### 🔴 Checkout button not responding

Hit by **2/4** agents across 2 personas: Speedrun Sam, Chaos Cathy

> *Speedrun Sam:* Clicked "Continue to checkout" button twice but it didn't advance to the checkout page. Button appears clickable but no navigation occurs.
> *Chaos Cathy:* I clicked the "Continue to checkout" button multiple times on the cart page, but nothing happened. The page remained on the cart page with no navigation to the checkout process. This completely blocks the user from completing a purchase.
