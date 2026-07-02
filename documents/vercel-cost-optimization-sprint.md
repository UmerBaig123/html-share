# Vercel Cost Optimization — Execution Plan

**Goal:** cut the Vercel bill from ~$2,000/mo to ~$900–1,100/mo without a single customer-visible tracking failure.
**Diagnosis & evidence:** see `vercel-cost-report.html` (charts, per-driver analysis, risk panels). This document is the build plan only.
**Repo:** `AgentKong_App` · **Vercel project:** `agent-kong-app` (team `agent-kong`)

---

## Ground rules (apply to every phase)

1. **The tracking path carries customer revenue data.** Every change to it ships behind a flag, canaries on one pixel, and has a rollback that takes effect in ≤5 minutes.
2. **Nothing merges without a before/after measurement plan** — record the metric first, change second.
3. Repo guardrails remain in force: no `prisma db push` / schema mutations, no destructive git, stack-schema sync rules. None of this plan requires a schema change — if one appears to be needed, stop and re-scope.
4. Deploys ride the normal `development` → `main` PR flow. No direct-to-main.
5. Each phase has an explicit **GATE** — do not start the next phase until the gate passes.

---

## Sequencing overview

```
Day 0        Phase 0  Baseline capture + invoice audit          (no code)
Day 1–2      Phase 1  Config-only wins: crons, maxDuration,
                      204 responses, script cache stage 1        (low risk)
Day 2–3      Phase 2  Heartbeat batching build + flag            (code)
Day 3–10     Phase 2  Canary → ramp → 100%                       (monitored)
Day 10–11    Phase 3  Memory right-sizing (light routes first)   (config)
Week 3–4     Phase 4  QStash offload of pageview after() work    (code, heaviest)
Week 4+      Phase 5  Re-measure, close out, set guardrails      (no code)
```

Solutions map (from the report): Phase 1 = Solutions 4 (partial), 5, 6 · Phase 2 = Solution 1 · Phase 3 = Solution 3 · Phase 4 = Solution 2.

---

## Phase 0 — Baseline capture & invoice audit *(Day 0 · no code · owner: team lead)*

### 0.1 Record the baseline (do this BEFORE any change)

- [ ] Screenshot/export from `vercel.com/agent-kong/~/usage`, per-day view:
  - Edge Requests (count/day)
  - Fluid Provisioned Memory (GB-hrs/day)
  - Fluid Active CPU (hrs/day)
  - Function Invocations (count/day)
- [ ] In Vercel Observability, record per-path baselines for the four hot routes: `/api/widgets/engagement`, `/api/widgets/pageview`, `/api/widgets/[pixelCode]`, `/api/webhook/[businessId]/[uuid]` — requests/day, p50/p95 duration. This also **confirms or corrects the estimated request mix** in the report (heartbeats assumed ~60% of volume).
- [ ] Note current Settings → Functions default memory size (assumed 2 GB standard — verify; Phase 3 math depends on it).

### 0.2 Invoice audit (Solution 6 — potentially $100–300/mo, zero code)

- [ ] Read **every** line item on the usage page and log each one's $ amount.
- [ ] If **Observability Plus** > $50/mo: enable sampling/exclusion for `pageview` + `engagement` paths only (keep webhook/conversion routes at full fidelity). Decision item #5 — pre-approved conditional on the audit.
- [ ] Settings → Billing: check **on-demand concurrent builds / enhanced build machines**. If enabled and the builds line item is non-trivial, disable for previews (accepts build queueing at peak commit hours).
- [ ] Count paid seats; flag any inactive members.
- [ ] Check Web Analytics / Speed Insights / Log Drains toggles per project; disable any nobody uses.

### GATE 0 ✅
Baseline numbers recorded in a shared doc; request-mix estimate confirmed (or the plan's savings estimates re-derived from the real mix); audit findings logged with $ amounts.

---

## Phase 1 — Config-only wins *(Day 1–2 · low risk · 1 PR)*

All changes in this phase are one-line config or trivially reversible route edits. Ship as **one PR** titled `perf(vercel): cron schedules, hot-route durations, response slimming`.

### 1.1 Cron schedule edits — `vercel.json` (Solution 5)

26 line edits. Approved set (decision #3 pre-approved: iClosed/Salesforce accept ≤5 min added latency; decision #4: latency-sensitive crons untouched):

| # | Cron | From | To |
|---|---|---|---|
| 1 | `cache-invalidation-processor` | `* * * * *` | `*/5 * * * *` |
| 2 | `cache-warm-dispatcher` | `* * * * *` | `*/5 * * * *` |
| 3 | `hubspot-form-submissions` | `*/5` | `*/15` |
| 4 | `hubspot-property-changes` | `*/5` | `*/15` |
| 5 | `close-reconciliation` | `*/5` | `*/15` |
| 6 | `clickfunnels-reconciliation` | `*/5` | `*/15` |
| 7–12 | `ghl-form-submissions`, `ghl-survey-submissions`, `ghl-opportunity-stage-reconcile`, `ghl-opportunity-status-reconcile`, `ghl-appointment-create-reconcile`, `ghl-appointment-update-reconcile` | `*/5` | `*/10` |
| 13 | `woocommerce-order-reconcile` | `*/5` | `*/10` |
| 14 | `tally-form-responses-reconcile` | `*/5` | `*/10` |
| 15 | `calendly-invitee-reconcile` | `*/5` | `*/10` |
| 16 | `typeform-submission-reconcile` | `*/5` | `*/10` |
| 17 | `fathom-periodic-sync` | `*/5` | `*/10` |
| 18 | `meta-leadgen-reconcile` | `*/5` | `*/10` |
| 19 | `iclosed-poll` | `*/5` | `*/10` |
| 20 | `salesforce-conversion-poll` | `*/5` | `*/10` |

**Explicitly NOT touched:** `send-booking-notifications`, `meta-capi-retry`, `follow-up`, `agent-pending-replies`, `process-pending-message-charges`, `enforce-wallet-suspension`, all `*-token-refresh` jobs.

**Watch note for fathom-periodic-sync:** its per-business skip uses `MIN_SINCE_LAST_SYNC_MS ≈ 4 min`; at a 10-min cadence every run dispatches. Expected and fine — just don't "optimize" the skip window in the same PR.

### 1.2 Hot-route duration caps

- `src/app/api/widgets/engagement/route.ts`: add `export const maxDuration = 10` (currently unset → 25s default; the handler is 4 DB ops).
- Review the 25 wildcard `maxDuration: 800` patterns in the `vercel.json` `functions` block; reduce only ones that are obviously oversized **and** have p95 < 60s in Observability (from Phase 0 data). If unsure, leave — maxDuration itself isn't billed.

### 1.3 Response slimming (part of Solution 1, safe to ship early)

- `engagement/route.ts`: return `204 No Content` instead of the JSON body. Verified: the widget client never reads the response (`pixel-generator.ts:2257–2259` only logs errors). Keep CORS headers identical.

### 1.4 Script cache — stage 1 only (Solution 4, decision #2: staged TTL)

- `src/app/api/widgets/[pixelCode]/route.ts`: keep `s-maxage=300` for now (rollout speed is needed for Phase 2), but add the **ETag/304 path** now: hash of (pixelCode + deploy id / script version), return `304` on `If-None-Match` match before doing the DB check.
- The TTL raise to 3600 happens in Phase 5, after the heartbeat rollout completes.

### Verification (48h watch)

- [ ] Vercel logs: no new errors on engagement route; 204s flowing.
- [ ] PlanetScale: spot-check that `page_views.timeOnPage/scrollDepth` still update.
- [ ] Cron freshness probe: for 2–3 integrations (GHL forms, HubSpot, iClosed), query newest ingested rows vs. source-system timestamps over 48h; confirm max lag ≈ new cron interval, no gaps. Webhook-covered integrations should show near-zero lag (webhooks still primary).
- [ ] No growth in `cache-invalidation` queue depth beyond transient bursts.

### GATE 1 ✅
48h clean: no error-rate change, no data-gap reports, cron queues draining. **Rollback:** revert the PR (pure config).

---

## Phase 2 — Heartbeat batching *(build Day 2–3, canary Day 3–10 · Solution 1 · the big one)*

### 2.1 Design

**Client** (`src/lib/tracking/pixel-generator.ts`, generated-script template):

1. Keep the existing 30s `setInterval` (line ~2446) but change `sendHeartbeat` to **update an in-memory `pendingEngagement` object only** (timeOnPage, scrollDepth, clickCount — same fields, same computation).
2. Flush triggers (all via existing `sendBeacon` helper, which the script already uses):
   - `visibilitychange` → `hidden` (primary; fires on tab switch, navigation, most closes)
   - `pagehide` (belt-and-braces; some browsers skip visibilitychange on close)
   - **5-minute periodic fallback** for long-lived visible tabs (caps max data loss window at 5 min)
   - flush-once guard per trigger burst (don't double-send on hidden+pagehide)
3. Payload unchanged in shape (`pixelCode, cookieId, url, timeOnPage, scrollDepth, ...`) — server merge is already `Math.max`-based, so late/duplicate/out-of-order flushes are harmless. Enforce a size guard (<10KB) before beacon.
4. **Kill switch:** the server embeds `engagementMode: "batched" | "legacy"` into the generated script (read from an env var or a per-pixel field — env var is simpler and global; per-pixel enables the canary). Recommended: per-pixel column-free approach — a hardcoded allowlist constant of canary pixelCodes in `pixel-generator.ts` for stage 1, then env flip for global. No schema change.
5. Audit the other periodic senders (`pixel-generator.ts:2163`, `:3249`, `/e` batch at `:3235`) — apply the same accumulate-and-flush pattern **only** where the response is verifiably unused; otherwise leave and note.

**Server** (`src/app/api/widgets/engagement/route.ts`): no logic change needed beyond Phase 1's 204 — the existing session/pageview lookup + `Math.max` update handles batched flushes as-is. Re-verify the 1-hour session-lookup window still covers a 5-min flush cadence (it does; flushes arrive well inside it).

### 2.2 Test plan (before any canary)

- [ ] Local: test page with the widget; simulate tab-switch, navigation, close, 6+ min idle visible tab. Assert exactly 1–2 engagement requests per scenario and correct final timeOnPage/scrollDepth in the DB.
- [ ] Cross-browser sanity: Chrome, Firefox, Safari (sendBeacon-on-pagehide behavior differs; Safari is the risk case — verify visibilitychange flush fires).
- [ ] Unit-test the merge property: send flushes out of order; final row values must equal the max.

### 2.3 Canary → ramp (decision #1 pre-approved)

| Stage | Scope | Duration | Success criteria |
|---|---|---|---|
| C1 | 1 internal/test pixel | 24h | engagement rows present for all sessions; values plausible vs. legacy |
| C2 | 1 friendly customer pixel (low stakes) | 48h | same + no support noise; request count for that pixel drops ~80% |
| C3 | 25% of pixels (allowlist) | 48h | error rate flat; per-path request count tracking projection |
| C4 | 100% (env flip) | — | Edge Requests/day drops toward ~50% of baseline within 24h (5-min script cache = fast propagation) |

**Verification queries at each stage (PlanetScale):** for canary pixel(s), compare last-24h distribution of `timeOnPage` / `scrollDepth` against the 7-day pre-change distribution — medians within ~10%, null-rate not increased. Count engagement requests per session (Vercel Observability per-path count ÷ session count) — expect ~10 → ~1.5.

**Rollback:** remove pixel from allowlist / flip env to `legacy` → propagates in ≤5 min via script cache. Data written during batched mode is fully valid (same fields), so rollback has zero cleanup.

### GATE 2 ✅
C4 complete + 72h stable: Edge Requests/day at ≤50% of baseline, engagement data distributions unchanged, zero related support tickets. Record the new memory GB-hrs/day — Phase 3 sizing uses it.

---

## Phase 3 — Memory right-sizing *(Day 10–11 · Solution 3 · config PR)*

Sequencing matters: light routes now, pageview only after Phase 4 slims it.

1. Confirm from Phase 0 what the project default actually is (assumed 2 GB).
2. `vercel.json` `functions` block — add `"memory": 1024` for:
   - `src/app/api/widgets/engagement/route.ts` (4 DB ops, I/O-bound) — **now**
   - `src/app/api/widgets/[pixelCode]/route.ts` (script serving) — **now**
   - `src/app/api/widgets/e/route.ts`, `payment-link-click` — **now**
   - `src/app/api/widgets/pageview/route.ts` — **only after GATE 4** (its attribution loops may need headroom today)
3. 48h watch: Vercel runtime errors filtered to these paths — zero OOM/`FUNCTION_INVOCATION_FAILED` growth; p95 latency shift <20%.

**Rollback:** delete the memory lines (single-line revert per route).

### GATE 3 ✅
48h clean on the three light routes. Memory GB-hrs/day down proportionally to those routes' share.

---

## Phase 4 — QStash offload of pageview `after()` work *(Week 3–4 · Solution 2 · decision #6 pre-approved, heaviest engineering)*

### 4.1 Build

1. **New worker route** `src/app/api/qstash/pageview-stitching/route.ts`:
   - Copy the existing QStash receiver pattern (signature verification etc.) from the workers under `src/app/api/qstash/` — do not hand-roll.
   - Body: `{ businessId, sessionId, contactId?, fingerprintData?, clickIds?, trigger }`.
   - Executes, in order, the four blocks currently inside `after()` in `pageview/route.ts`: duplicate-contact sweep (`:813`), fingerprint session linking (`:277`), gclid stitching (`:406`), conversion re-attribution (`:531`). Extract each into functions under `src/lib/tracking/stitching/` so route + worker share one implementation during migration.
   - `maxDuration = 120`, standard memory.
2. **Idempotency & ordering** (the new failure surface — treat as first-class):
   - Worker must be safe to run twice: all four blocks are already merge/max/upsert-shaped, but verify each and add guards where not (e.g., contact merge must tolerate the duplicate already being merged).
   - Use QStash **deduplication id** = `sessionId:contactId:5-min-bucket` to collapse bursts from rapid pageviews of the same session.
   - No strict ordering guarantee → re-attribution must re-derive from DB state, never from message payload state (it already queries fresh — keep it that way).
3. **Publisher change** in `pageview/route.ts`: `after()` now only publishes one QStash message (~50–150ms) instead of running the work. Keep a `STITCHING_MODE=inline|qstash` env flag so the old inline path remains one flip away.
4. **Batching win (where the real net savings come from):** in the worker, when a dedup-collapsed message arrives, process the whole session's pending work once — not once per pageview.

### 4.2 Regression testing (blocking, per repo rules: test at scale)

- [ ] Replay-style test against a **500k+ pageview / 50k+ conversion account's data shape**: run inline mode and qstash mode on equivalent fixtures; diff outcomes — contacts merged, sessions linked, conversion attribution rows. Must be equal (allowing timing-window differences ≤ QStash delivery lag).
- [ ] Chaos cases: worker retried twice; two messages for same session processed concurrently; message delayed 10 min. No duplicate merges, no attribution flapping.
- [ ] Measure: pageview route billed duration p50/p95 before vs after (expect ~3–5s → ~0.5–1s).

### 4.3 Rollout

Canary by business (one mid-size account, 48h) → 100% via env flag. Monitor: QStash DLQ empty, worker error rate <0.1%, attribution-upgrade lag (conversion shows Direct→paid) within minutes.

**Rollback:** `STITCHING_MODE=inline` — restores exact current behavior; in-flight QStash messages drain harmlessly (idempotent).

### GATE 4 ✅
72h at 100%: regression diffs clean, DLQ empty, pageview p95 duration down ≥60%. **Then** apply Phase 3's memory reduction to the pageview route.

---

## Phase 5 — Close-out *(Week 4+ · no code)*

1. **Script cache stage 2** (decision #2): raise `/api/widgets/[pixelCode]` to `s-maxage=3600, stale-while-revalidate=86400` now that no widget rollout is pending. Document the new ≤1h propagation in support docs (including disabled-pixel lag).
2. **Re-measure** all Phase 0 metrics over a full 7-day window. Publish before/after table against the projection:

| Metric | Baseline | Target |
|---|---|---|
| Edge Requests / day | (Phase 0) | −55–65% |
| Provisioned Memory GB-hrs / day | (Phase 0) | −60–70% |
| Active CPU hrs / day | (Phase 0) | −40–50% |
| Monthly bill | ~$2,000 | ~$900–1,100 |

3. **Guardrails so it doesn't regress:**
   - Set Vercel **Spend Management** alerts at the new expected level (+25%).
   - Add a PR-review checklist line for `vercel.json` cron additions and any new endpoint called by the widget (each widget request ×160M/mo).
   - Calendar a monthly 15-min usage-page review.
4. Update `vercel-cost-report.html` numbers with measured actuals (keep both docs in sync).

---

## Decision status (from the report's checklist)

| # | Decision | Status |
|---|---|---|
| 1 | Heartbeat batching w/ canary | **Approved** (user: "optimize freely") — canary plan above |
| 2 | Script cache TTL | **Staged**: 300s + ETag during rollout → 3600s in Phase 5 |
| 3 | +5 min latency on iClosed / Salesforce polling | **Approved** (10-min schedule) — flag to affected customers if asked |
| 4 | Latency-sensitive crons | **Keep as-is** — excluded from Phase 1 |
| 5 | Observability sampling on widget routes | **Conditional** — Phase 0 audit decides (>$50/mo threshold) |
| 6 | QStash migration | **Approved, sequenced last** — Phase 4 with regression gate |

## Rollback matrix (one place, for on-call)

| Change | Rollback action | Time to effect |
|---|---|---|
| Cron schedules | revert `vercel.json` PR + redeploy | ~5 min |
| 204 / maxDuration on engagement | revert route file | ~5 min |
| Heartbeat batching | remove pixel from allowlist / env → `legacy` | ≤5 min (script cache) |
| Memory 1024 | remove `memory` lines | ~5 min |
| QStash stitching | `STITCHING_MODE=inline` | ~5 min; queue drains harmlessly |
| Script TTL 3600 | lower TTL; existing caches age out | ≤1 h tail |

## Effort summary

| Phase | Engineering | Elapsed (incl. soak) |
|---|---|---|
| 0 | 0.5 day | Day 0 |
| 1 | 0.5–1 day | Day 1–2 (+48h watch) |
| 2 | 1–2 days build + monitored ramp | Day 2–10 |
| 3 | hours | Day 10–11 (+48h watch) |
| 4 | 2–3 days + regression suite | Week 3–4 |
| 5 | 0.5 day | Week 4+ |
| **Total** | **~5–7 engineering days** | **~4 weeks elapsed** |
