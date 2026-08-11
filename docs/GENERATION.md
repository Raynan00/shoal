# 🧬 Dynamic persona generation

Shoal's built-in personas ([`personas.yaml`](../packages/core/personas/personas.yaml)) are a
starting library. The real power is **synthesizing personas dynamically** so the swarm
mirrors *your* audience, from one of two inputs:

- **Product outlook** — what the product is and who it's for (or inferred from the target
  URL by vision). The cold-start case: no analytics needed.
- **Log data** — real analytics (PostHog / Sentry / Clarity). The grounded case: personas
  weighted by your actual traffic and primed to hit your actual failure points.

Both reduce to one `AudienceBrief` (a product statement + grounded signals), which one
synthesis step turns into a weighted panel of distinct simulated users in the same schema
the built-in library uses.

## Generate a reusable panel

```bash
# From a product description
npm run shoal -- personas generate \
  --audience "A B2B invoicing SaaS for freelance designers; mostly non-technical, split desktop/mobile" \
  --n 12 --out my-personas.yaml

# Inferred from the live site (vision reads the landing page)
npm run shoal -- personas generate --from-url https://your-app.test --n 12 --out my-personas.yaml

# Grounded in real analytics (see the JSON shape below)
npm run shoal -- personas generate --from-logs ./analytics.json --n 12 --out my-personas.yaml
```

The YAML is human-editable and versionable — treat a generated panel as an artifact you
refine, not a black box. Omit `--out` to print to stdout.

## Generate inline for a single run

```bash
# Synthesize 15 personas from a description, then swarm with them
npm run shoal -- run https://your-app.test --generate 15 \
  --audience "impulse-buy streetwear store, Gen-Z, almost entirely mobile"

# Let shoal infer the audience from the page itself
npm run shoal -- run https://your-app.test --generate 15

# Ground the swarm in your real logs
npm run shoal -- run https://your-app.test --generate 15 --from-logs ./analytics.json
```

When the swarm is larger than the generated panel, each persona is used at least once and
the rest are **weight-sampled** by the panel's real-audience distribution.

## Log-data JSON shape

The `--from-logs` file is a normalized export. The connectors that *fetch* this from
PostHog / Sentry / Clarity are a thin unbuilt layer — any of those tools reduces to this
contract, and a sample lives at
[`fixtures/sample-logs.json`](../packages/core/fixtures/sample-logs.json). All fields are
optional; provide what you have.

```json
{
  "product": "one-line description (optional; inferred from signals if omitted)",
  "distribution": [
    { "segment": "impatient mobile shopper", "share": 0.42 }
  ],
  "dropoffs": [
    { "step": "cart → checkout transition", "rate": 0.34 }
  ],
  "errors": [
    { "message": "TypeError: cannot read ...", "route": "/checkout", "count": 214 }
  ],
  "rageClicks": [
    { "element": "Continue to checkout button", "count": 143 }
  ]
}
```

Each signal shapes the panel: `distribution` sets the *weights*, `dropoffs` and
`rageClicks` produce personas *primed to hit and react to* those spots, and `errors`
produce a persona that *reproduces the triggering path*. That's how a swarm stops being a
guess and starts being a scale model of your real users.

## Auth & models

Generation is a single reasoning/vision call, so it needs Anthropic credentials:
`--provider anthropic` (API key, uses `claude-opus-5`) or `--provider subscription` (your
Claude Code login, uses `claude-sonnet-4-6`). It does **not** use structured-output mode,
so it stays portable across models and degrades gracefully. Generating on an
OpenAI-compatible endpoint is a planned addition.

> **The moat.** Product-outlook generation is the cold-start on-ramp. The log-data path is
> the defensible product: personas trained on the customer's private analytics, which no
> competitor can copy from this repo. See [VISION.md](VISION.md) §3.
