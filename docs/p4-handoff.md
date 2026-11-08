# P4 → P2 handoff

Branch: **`P4`**, in `sss9746/DatacenterOS`. Implementation milestone: `9239547`. P2 dependency commit: `b71ad91`, merged into P4 by `6791177`. P4 did not modify P2's source. The frontend and evaluator are under `apps/web/` and `apps/evaluation/`; the lockfile was updated for their dependencies. The integrator still owns merging to `main`.

## Start here

Read `plans/CONTRACTS.md` §0, `plans/status/P4.md`, and this handoff. Inspect or run P4 without overwriting your P2 work:

```sh
git fetch origin P4:refs/remotes/origin/P4
# From your repo, use a separate inspection worktree if the path is free:
git worktree add --detach ../dcos-p4-review origin/P4
cd ../dcos-p4-review
corepack pnpm install
corepack pnpm --filter @dcos/web dev
```

Continue P2 implementation on your P2 branch. Do not recreate the frontend or move simulation logic into it. P4 consumes the actual `@dcos/db-client` types and wrappers; no duplicate wire/DB type definitions were introduced.

## Client calls P4 already uses

| API | Consumer / expectation |
| --- | --- |
| `createMockClient({ snapshot })` | `src/data/dashboard.ts`; current P2 fixtures, with `demo` / `pump_degraded` snapshots |
| `connect({ uri, db, token?, runId })` | Same file; live connection failures are visible and never replaced with mock data |
| `getObservedSnapshot()` | Complete public clock/GPU/node/cooling/job/allocation/checkpoint state |
| `getEvidence([], 600000)` | Run-wide signals, incident links, symptoms and public telemetry; no fault truth |
| `onGpu`, `onJobs`, `onIncidents` | Public subscriptions; immediate full lists per current interface |
| `onActions`, `onAgentEvents`, `onEvaluation` | Public full-list subscriptions; renderer uses canonical types |
| `onChange` | Triggers snapshot refresh after material changes |
| `pauseRun`, `configureRun({ speed })`, `injectFault`, `createRun` | Judge panel / run controls; admin-only in live mode |
| `close()` and returned unsubscribe functions | Called during reset, source changes, reconnection and unmount |

The adapter serializes snapshot refreshes and coalesces subscription bursts. It also refreshes the public snapshot once per second because there is no `onRun` or `onCooling` API yet. It retains the last snapshot on read failure and warns about interrupted/stale updates.

The mock playback calls P2's exposed `tick()` on a speed-adjusted timer. This is **mock only**. Live time is always read from the DB; P4 does not call `advance_tick` or implement simulation. `loadSnapshot` and scripted `upsertIncident` / `publishAgentEvent` calls are limited to the explicitly labeled recovery preview.

## P2 work needed next

1. **Live client:** current `src/live.ts` always throws. Implement public subscriptions and admin reducers behind the existing API, resolving `connect()` only once initial subscriptions are ready. Make disconnect/reconnect and stale data observable. Complete Gate 1 with real ticks, pump heating and XID rollback in the browser.
2. **Fixture clocks:** both current snapshots still start at zero and preset checkpoints are stamped zero. CONTRACTS §0.12 requires run start `600000`, job-a checkpoint `60000`, job-b `540000`. P4 currently says checkpoint age is unavailable for these legacy fixtures; it does not rewrite P1's data. Coordinate regeneration with P1 and run P2's fixture sync.
3. **Cooling:** fixtures contain pump rows only. P4 displays the mapped loops but says `no telemetry` until loop-a/loop-b rows arrive (§0.11 #9).
4. **Action metadata:** `onActions` returns `ActionStatus[]`, which has no operation, target/job, dependencies, or historical action events. P4 preserves `command_key`, status, attempt, version, time and violations, but displays operation as unavailable. Add a typed public projection or metadata/history subscription rather than asking P4 to infer operation from command keys. Include safety evidence when available so the UI can state actual versus required headroom; currently it gives the reason-code explanation without invented numbers.
5. **Manual actions / roles:** the documented admin API cannot request actions; `requestAction` belongs to the agent role. Agree with the integrator on an authorized presenter action endpoint before implementing the manual checkpoint/hot-r6 Gate 2 demonstration. P4 intentionally does not grant itself agent permissions or bypass safety.
6. **Reset semantics:** current mock `createRun` does not clear incidents/actions/evaluation state. P4 resets its mock session by creating a fresh client. Live reset must establish a consistent new run across subscribers; do not leave old rows mixed into a reset session.
7. **Mock gaps:** mock XID 48 is disabled in the UI because `injectFault` implements no visible effect for it. Mock pump injection swaps the whole fixture and its clock; this is disclosed as fixture playback, not live physics.
8. **Evaluation provenance:** `EvaluationResult` lacks unfinished-job counts, cache usage, model-fallback usage and policy/physics versions. P4's offline summary has version/cache slots, but public rows cannot express them. Coordinate additive schema/client changes with the integrator. Scoreboard comparisons require matching `run_id`, `scenario_id` and `seed` for all three policies; different policy run IDs will remain unmatched.
9. **Hardware:** Brev display accepts only `source_kind: hardware`, `resource_id: gpu-real-0`, `labels.collector: nvidia-smi`; freshness uses `observed_unix_ms` with a 15-second UI stale threshold. Real GPU stays nonallocatable.

## UI handoff and evidence

Implemented: responsive topology and inspection, cooling/headroom, jobs/durability/history, separate incidents, actor-tagged tool summaries, ledger/filtering/BLOCKED reasons, judge controls, real GPU empty/stale states, and result-driven benchmark rendering with exports/distributions/loss cases.

The recovery selector seeds **scripted examples**, labeled globally and in the relevant panels. No model call, real safety decision or benchmark is claimed. Default benchmark state is empty. The frontend never imports private `PhysicsWorld` or reads fault-injection truth.

Verified before handoff:

- `corepack pnpm -r test`: **137 tests pass** (92 physics, 15 contracts, 15 DB client, 9 evaluation, 6 dashboard).
- Web production build and evaluation TypeScript build pass.
- `corepack pnpm contracts:validate`: all six schema fixtures valid.
- Desktop (1440 × 1000 viewport) and mobile (390 × 844) Chrome tests pass: 64 tiles, pause, arrow-key inspection, XID 79 job rollback, reset, two incidents, expandable tool calls, no horizontal page overflow, no page errors.
- axe WCAG A/AA scan: zero reported violations in those tested recovery states.
- Independent Impeccable review found a connection-label/visibility issue; the follow-up labels configured live mode without implying connectivity and preserves actual status at all breakpoints.

Screenshots are local ignored QA artifacts (`apps/web/.impeccable/review/`), not committed data. No live gate or benchmark run is certified. No Vercel URL or Devpost registration/submission has been produced by this work.

### Known UI follow-ups from the independent review

These remain P4 work and should not hold up P2's backend implementation:

- At 320px width, cooling metadata forces horizontal overflow (355px document width). The tested 390px and desktop layouts fit. Fix pump-reading wrapping and shrinking before claiming 320px support.
- Some operational metadata is 9–10px; prioritize larger work/durability/evidence text and touch-friendly inspection.
- Section navigation permanently highlights Overview; make its selected state follow the active section and improve intermediate-width icon labels.
- Reset completion loses keyboard focus; restore focus and announce completion. Add concise announcements for critical incidents and blocked/completed actions before live accessibility verification.

The Impeccable source detector reported zero findings, while its browser scan surfaced small-text instances and manual review found the items above. Zero axe/source-detector findings do not mean these usability follow-ups are resolved. The connection-mode/status issue was corrected and independently rechecked, including 1000px and 320px visibility.

## Remaining P4 work after P2/P1 land

Verify live Gate 1–3 demonstrations, add typed operation/history rendering when available, bind the evaluation adapter to P1's runner/P3's policy, execute at least ten scenarios × three policies, verify populated benchmark provenance, deploy to Vercel, and complete pitch/video/Devpost evidence. Keep progress commits on `P4` and let the integrator merge to `main`.
