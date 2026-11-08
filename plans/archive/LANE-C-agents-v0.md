# LANE C: Agents + LLM infra (`agents/**`)

> **Read `plans/CONTRACTS.md` first.** If anything below disagrees with CONTRACTS, CONTRACTS wins and this file is wrong. Tell Suvan (Lane S).
> Written Sat Nov 7, 4:45 PM. Feature freeze **Sun 10:00 AM**. Submission **Sun 12:00 PM**.

---

## 1. Your role in one paragraph

You build the "AI team" that keeps the facility running. Python 3.12 + `uv`. Your code reads **only public** SpacetimeDB tables over HTTP (CONTRACTS §4), calls reducers and the `simulate_plan` procedure, and talks to **Nemotron 3 Nano Omni** (`nvidia/Nemotron-3-Nano-Omni-30B-A3B-Reasoning`) through the OpenAI SDK. There are three agents: **diagnose** (detect + diagnose), **plan** (plan + simulate) and **execute** (execute + verify, with one replan). There is also a **handoff** writer, a **worker** that polls incidents, and a **FastAPI** service on port 8787 that Lane D calls (`/health`, `/agent/ask`, `/agent/run/{id}`). The agents never see ground truth. They must find contradictions themselves: ticket #41 says "repaired", but telemetry says `pump_B` is offline. On stage you narrate the agent steps (demo beat 0:55–1:25) and answer judges' agent questions.

### 1.1 Paths you own, and paths you never touch
| You own (only you edit) | Never touch (ask the owner with an issue `REQUEST <lane>: …`) |
|---|---|
| `agents/**`, `plans/status/C.md` | `plans/CONTRACTS.md`, `packages/physics/**` (incl. fixtures), `spacetime/module/**`, `eval/**` (you *run* it with S, you don't edit it), `apps/web/**`, `hardware/**`, `scripts/**`, `qa/**`, root files (`package.json`, `.env.example`, `.gitignore`, `README.md`, `CODEOWNERS`) |

**Lane A imports `agents/dcos_agents/stdb.py`.** Never change the signatures of `sql`, `call`, `proc` or `StdbError`.

### 1.2 Sync schedule (be at the laptop, rebased, with checks passing)
| Time | What you bring | What you get |
|---|---|---|
| **7:00 PM** | `stdb.py` + selftest green on `dcos-dev`, tools passing in fixture mode | Schema freeze v1, rebase on `main` |
| **9:00 PM** | Diagnose agent answers the Pump A question in fixture mode | First live integration |
| **11:00 PM** | `/agent/ask` green on prod `dcos` (§4.2 MVP checklist row) | `git tag mvp` |
| **1:30 AM** | Planner + execute/verify on `dcos-dev`; 3 lines in `#status` | Hand-off before A and D sleep |
| **3:00 AM** | (B + C) hard-piece check: 4 scenarios | `git tag hard-piece` |
| **7:30 AM** | Challenge mode + handoff merged | Full demo run |
| **9:45 AM** | Last PR (bug fixes only) | **10:00 AM freeze**, `fix(demo):` only after it |

**Sleep: 4:30–7:30 AM** (PLAN §6.1). Before sleeping, **stop the Brev instance** (§2.6) and write `plans/status/C.md`.

---

## 2. Brev + Nemotron NIM runbook (task C-P0-02)

**Hard rules:**
- Budget: **at most $120 of the $160** across all 4 Brev accounts. The primary instance runs on **your** account. The other 3 accounts are backups, and everyone redeems their $40 now.
- **Decision deadline 6:00 PM.** If you don't have a valid `tool_calls` response from Brev by then, switch `llm.py` to the hosted API (§2.7) and keep going. Retry Brev later only if you have spare time.
- Never paste the NGC key or `NVIDIA_API_KEY` into git, chat or screenshots.

### 2.1 Get keys (10 min, while the code installs)
1. **NGC API key:** ngc.nvidia.com → your profile → *Setup* → *Generate API Key* (it starts with `nvapi-`). You need it to pull `nvcr.io` images.
2. **build.nvidia.com key** (this is the fallback LLM): open the model page for Nemotron 3 Nano Omni on build.nvidia.com → *Get API Key*. Put it in `.env.local` as `NVIDIA_API_KEY`. One key often works for both NGC and the hosted API; if it does, you only need one.
3. Read the **model card** on build.nvidia.com / NGC and write these down in `plans/status/C.md`:
   - the exact **container image + tag**
   - the **supported GPUs / profiles**
   - whether **tool calling** needs a flag
   - how to **turn reasoning on or off**
   - the **hosted model id**
   Everything marked *check model card* below comes from there.

### 2.2 Launch the GPU (15 min)
1. brev.nvidia.com → log in → redeem the credit → *New instance* (GPU).
2. Pick the GPU. **Look at the $/hr shown and write it down.**
   | Option | Fit (check model card) | Choose when |
   |---|---|---|
   | **A100 80 GB** | 30B MoE weights fit in BF16 with room for KV cache | It's available and ≤ ~$2.50/hr |
   | **L40S 48 GB** | BF16 30B (~60 GB) probably does **not** fit, so you need an **FP8/quantized profile** if the card lists one | A100 is unavailable or too pricey, *and* the card lists an L40S/FP8 profile |
3. Choose the VM/Docker image with NVIDIA drivers + Docker preinstalled (Brev's default GPU VM). Disk **≥ 200 GB** (the NIM cache is large).
4. Budget math: at $X/hr, total hours = 120 / X. For example, $2/hr gives 60 h, which is enough to run all night. Still **stop it while you sleep**, unless the eval needs it (decide at 1:30 AM).

### 2.3 Run the NIM container (download takes 10–30 min, so start it early)
```bash
# Get a shell on the instance (the Brev CLI prints the exact command; or use the console's "Open terminal")
brev login && brev shell <instance-name>          # check `brev --help` if this differs

export NGC_API_KEY=nvapi-...                     # type it; don't paste it anywhere public
echo "$NGC_API_KEY" | docker login nvcr.io -u '$oauthtoken' --password-stdin
export LOCAL_NIM_CACHE=~/.cache/nim && mkdir -p "$LOCAL_NIM_CACHE"

# TEMPLATE ONLY: copy the real `docker run` from the model card. Don't invent flags.
docker run -d --name nemotron --gpus all --shm-size=16GB \
  -e NGC_API_KEY -v "$LOCAL_NIM_CACHE:/opt/nim/.cache" -u $(id -u) \
  -p 127.0.0.1:8000:8000 \
  nvcr.io/nim/<CHECK-MODEL-CARD-image>:<CHECK-MODEL-CARD-tag>
docker logs -f nemotron                           # wait for "Uvicorn running on ... 8000" / "ready"
```
`-p 127.0.0.1:8000:8000` binds to localhost only, so **the port is not public**. That's intentional.

### 2.4 Expose port 8000 securely (an SSH tunnel is the preferred way)
- **Preferred:** on your laptop, run `brev port-forward <instance-name> --port 8000:8000` (check `brev --help`). Or, after `brev refresh` writes your SSH config, run `ssh -N -L 8000:localhost:8000 <instance-name>`.
- Then use `NIM_BASE_URL=http://localhost:8000/v1` in `.env.local`. **Keep the tunnel terminal open**, and restart it if the laptop sleeps.
- **Avoid** opening a public Brev port. If you must (e.g., the demo laptop can't hold the tunnel), add a reverse proxy with a bearer token, and never leave it open overnight.

### 2.5 Test it (must pass before C-P0-04 is done)
```bash
curl -s localhost:8000/v1/models | python -m json.tool          # shows the model id; copy it into NIM_MODEL
curl -s localhost:8000/v1/chat/completions -H 'Content-Type: application/json' -d '{
  "model": "nvidia/Nemotron-3-Nano-Omni-30B-A3B-Reasoning",
  "max_tokens": 512,
  "messages": [{"role":"system","content":"You are a data center agent. Use tools."},
               {"role":"user","content":"What is the status of pump_B?"}],
  "tools": [{"type":"function","function":{"name":"get_component_status",
     "description":"Live observed status of one component",
     "parameters":{"type":"object","properties":{"id":{"type":"string"}},"required":["id"]}}}],
  "tool_choice": "auto"}' | python -m json.tool
```
**Pass:** `choices[0].message.tool_calls[0].function.name == "get_component_status"`, with `arguments` that parse to `{"id": "pump_B"}`. Write down the latency. **Over 10 s per call is a fallback trigger** (PLAN §8).
If the reply has reasoning text (`<think>…` or a `reasoning_content` field) that eats the 512 tokens, apply the model card's reasoning toggle. `llm.py` strips reasoning before parsing.

### 2.6 Stop it when idle
- Stop the instance from the Brev console (or with the CLI's stop command). **Stop, don't delete:** the NIM cache stays on disk, so a restart takes about 3–5 minutes instead of 30.
- Stop it at **4:30 AM** (your sleep), unless the overnight eval needs it. **Restart at 7:30 AM.** Keep it warm from **12:30 PM Sunday** through judging.
- At **8:00 AM**, check the total spend. If it's over $90, stop the instance between rehearsals and judge on the hosted API (PLAN §8).

### 2.7 Fallback chain (built into `llm.py`)
| Order | Provider (`/health` `llm` value) | Base URL | Key | Model |
|---|---|---|---|---|
| 1 | `brev-nim` | `NIM_BASE_URL` | `"not-needed"` | `NIM_MODEL` |
| 2 | `nvidia-hosted` | `https://integrate.api.nvidia.com/v1` | `NVIDIA_API_KEY` | the hosted id from the model card (often the same string) |
| 3 | `local` | `http://localhost:8081/v1` (llama.cpp `llama-server -m <small-nemotron>.gguf --port 8081 --jinja`) | `"none"` | the GGUF name |

**When to switch:** after **2 consecutive errors**, or **one call taking more than 20 s**, move to the next provider. The choice is sticky. A background probe retries provider 1 every 60 s and switches back when it's healthy. Every switch is logged and shown in `/health`.

---

## 3. Package layout (everything in `agents/`)
```
agents/pyproject.toml          # uv; deps: openai, httpx, pydantic>=2, fastapi, uvicorn, python-dotenv; dev: pytest, ruff
agents/README.md               # how to run (S copies the summary into root README; README.md is S-owned)
agents/BREV.md                 # the §2 runbook with the real values filled in
agents/dcos_agents/
  constants.py     # verbatim copy of CONTRACTS §1 as Python tuples/constants (+ OPERATOR_QUESTION = "operator_question")
  config.py        # loads repo-root .env.local (or --env-file); exposes Settings (STDB_HOST, STDB_DB, STDB_AGENT_TOKEN, NIM_*, LLM_*)
  stdb.py          # sql(), call(), proc(), StdbError; picks HttpStdb or FixtureStdb by STDB_MODE
  fixture_stdb.py  # FixtureStdb: in-memory tables from packages/physics/fixtures/rows_public.json
  llm.py           # chat(messages, tools) with the provider chain, usage accounting, reasoning stripping
  tools.py         # 12 tools + TOOL_SCHEMAS + dispatch(name, args) with pydantic arg models
  steps.py         # StepLogger: log_agent_step wrapper, step_no counter, 280-char summaries, 4 KB payload cap
  loop.py          # run_tool_loop(): the shared tool-calling engine
  prompts.py       # system prompts (§5.2)
  detect_diagnose.py / plan_simulate.py / execute_verify.py / handoff.py / ask.py
  worker.py        # incident poller, run lock, Challenge-mode cancel
  api.py           # FastAPI app; `python -m dcos_agents.api [--no-worker] [--port 8787]`
  selftest.py      # `python -m dcos_agents.selftest`
agents/tests/      # conftest.py (sets STDB_MODE=fixture), test_stdb.py, test_tools.py, test_loop.py, test_plan.py, test_ask.py, test_live.py
```

**`stdb.py` details** (CONTRACTS §4):
- `sql(q)`:
  - `POST {STDB_HOST}/v1/database/{STDB_DB}/sql` with a `text/plain` body.
  - The response is `[{"schema": {"elements": [...]}, "rows": [[...]]}]`.
  - Column names may arrive as `"x"` or as `{"some": "x"}`. Handle both.
  - Zip the column names with the rows.
  - Coerce any all-digit string in a u64 column to an `int` (do it for every u64 in §3.1; when in doubt, coerce digit strings in columns named `id`, `tick`, `*_tick` and `seed`).
- `call(reducer, *args)`:
  - `POST …/call/{reducer}` with `json=list(args)`.
  - A non-200 response raises `StdbError(status, text)`.
- `proc(name, *args)`:
  - Same request as `call`.
  - Returns the JSON. **If the result is a `str`, `json.loads` it again**, because the procedure may return the Outcome as a JSON string.
- Retries: back off 0.5, 1, 2 s, **only on network errors and 5xx**. Never retry `FORBIDDEN:`, `INVALID:` or `NOT_FOUND:`.
- Header on every request: `Authorization: Bearer {STDB_AGENT_TOKEN}`. Timeout 10 s.
- **SQL style rule:** `SELECT * FROM <table> [WHERE col = 'v' [AND col2 = n]]` only. **No `ORDER BY`, `LIMIT`, `!=`, `JOIN` or `IN`.** Sort and filter in Python. This keeps the queries safe on SpacetimeDB's SQL subset and parseable by `FixtureStdb`.

**`FixtureStdb`** (`STDB_MODE=fixture`; bash `STDB_MODE=fixture uv run …`, PowerShell `$env:STDB_MODE="fixture"; uv run …`):
- Loads `../packages/physics/fixtures/rows_public.json`. Until it lands at 6:15 PM, use a hand-written `agents/tests/data/mini_rows.json` with the same table names.
- `sql()`: a tiny regex parser for the style rule above. Reading `ground_truth`, `failure`, `allowlist`, `tick_schedule` or `run_config` raises `StdbError(403, "FORBIDDEN: private table")`, which mirrors production.
- `call()`:
  - Appends to an in-memory `calls` list.
  - `log_agent_step`, `write_shift_note`, `update_incident` and `request_action` insert or update the in-memory rows.
  - `request_action` uses a **heuristic safety check**: cooling = the sum of `capacity_kw` over online pumps minus the target, and load = the rack `load_kw` sum. If cooling < load, the action is `blocked` with `"BLOCKED: cooling 0 kW < load 48 kW"`; otherwise it's `approved` with `"OK: fixture"`.
- `proc("simulate_plan", actions_json, ticks)`: the same heuristic, returning an `Outcome` dict. Its numbers are fake, but its shape is real.
- The fixture is for building only. **Every acceptance test reruns live** (`-m live`).

---

## 4. Task table

**Columns:** each task has an ID, a time window, a duration, its dependencies, the files it touches, the commands to run, and its definition of done (DoD).
**External dependencies:**
- **S-FIX:** S's fixtures, due 6:15 PM
- **FREEZE:** the schema freeze at 7:00 PM
- **S-PROD:** P1-B-06, prod `dcos` published plus your identity allow-listed (~10:15 PM)
- **S-SIM:** the `simulate_plan` procedure, P2-B-01 (~12:45 AM)
- **A-FRZ:** `sensor_freeze` in physics, P2-A-01 (~12:15 AM)
- **S-EVAL:** the local `dcos-eval` DB, P2-B-02 (~1:30 AM)

### Phase 0: Setup (4:45–5:45 PM)
| ID | Window | Dur | Depends | Files | Commands | DoD + test |
|---|---|---|---|---|---|---|
| C-P0-01 | 4:45–5:00 | 15m | repo cloned | `pyproject.toml`, `constants.py`, `config.py`, empty module stubs | `cd agents && uv init --package --python 3.12 && uv add openai httpx "pydantic>=2" fastapi uvicorn python-dotenv && uv add --dev pytest ruff` | `uv run python -c "import dcos_agents.constants as c; print(c.ACTION_KINDS)"`. Commit the **stub signatures** so the sub-agents (§8) can branch from them |
| C-P0-02 | 4:50–5:45 (mostly waiting) | 55m | NGC key | `agents/BREV.md` | §2.2–2.5 | §2.5 curl returns `tool_calls`. **6:00 PM go/no-go** |
| C-P0-03 | 5:00–5:40 | 40m | P0-B-01 (`dcos-dev` up) | `stdb.py`, `selftest.py`, `tests/test_stdb.py` | `curl -X POST $STDB_HOST/v1/identity` → put the token in `.env.local` as `STDB_AGENT_TOKEN`, and send **only the identity hex** to S to run `allowlist_add(hex,"agent")` | `uv run python -m dcos_agents.selftest` prints PASS for the four checks: (1) a reducer call `log_agent_step(0,"diagnose",0,"thought","","selftest","{}")` (2) `SELECT * FROM facility` returns rows (3) u64 round-trip: `facility.tick` and `agent_step.id` are `int` (4) `SELECT * FROM ground_truth` **raises** `StdbError`. Also `uv run pytest tests/test_stdb.py` (MockTransport: string u64 → int, `{"some":…}` names, error mapping) |
| C-P0-04 | 5:15–5:45 | 30m | the hosted key | `llm.py`, `tests/test_llm.py` | `uv run python -m dcos_agents.llm --ping` | The ping with one tool returns a tool call through **brev-nim or nvidia-hosted**. The selftest adds a 5th check: an LLM tool call |

### Phase 1: MVP core (5:45–11:00 PM)
| ID | Window | Dur | Depends | Files | Commands | DoD + test |
|---|---|---|---|---|---|---|
| C-P1-01 | 5:45–6:30 | 45m | S-FIX (6:15; use mini fixture before) | `fixture_stdb.py`, `tests/conftest.py`, `tests/data/mini_rows.json` | `STDB_MODE=fixture uv run pytest -q` | All of `sql/call/proc` work offline. A private-table read raises FORBIDDEN in fixture mode too |
| C-P1-02 | 6:00–7:00 | 60m | C-P1-01 | `tools.py`, `tests/test_tools.py` | `uv run pytest tests/test_tools.py -q` | All **12** tools (§5.1) dispatch through pydantic arg models; `TOOL_SCHEMAS` are valid OpenAI function schemas; every result is ≤ 4 KB after `truncate()` |
| SYNC | 7:00 | — | FREEZE | — | `git fetch && git rebase origin/main`, rerun the selftest on `dcos-dev` | Report green/red in chat |
| C-P1-03 | 7:00–8:15 | 75m | C-P1-02, C-P0-04 | `steps.py`, `loop.py`, `prompts.py`, `tests/test_loop.py` | `uv run pytest tests/test_loop.py -q` (a scripted fake LLM) | Loop rules (§5.3) all pass: max 8 steps, one retry on a bad call, the second failure gives `failed`, every step is logged |
| C-P1-04 | 8:15–9:00 | 45m | C-P1-03 | `detect_diagnose.py`, `ask.py`, `tests/test_ask.py` | `STDB_MODE=fixture uv run pytest tests/test_ask.py -q` | The Pump A question gives an answer containing "41" and "pump_B", `action_status="blocked"`, ≥ 4 `tool_call` steps; all 5 paraphrases pass (§6) |
| SYNC | 9:00 | — | — | — | Demo `ask` in fixture mode, then against `dcos-dev` | — |
| C-P1-05 | 9:00–10:00 | 60m | C-P1-04 | `api.py`, `worker.py` | `uv run python -m dcos_agents.api --port 8787` then `curl localhost:8787/health`, and `curl -X POST localhost:8787/agent/ask -H 'Content-Type: application/json' -d '{"question":"Can I shut down Pump A for maintenance?"}'` | `/health` and `/agent/ask` return exactly the CONTRACTS §5 shapes; the worker claims `new` incidents within 1 s and runs diagnose; CORS `*` |
| C-P1-06 | 10:00–10:30 | 30m | S-PROD | `.env.local` only | Allow-list the **same** identity on `dcos` (ask S); set `STDB_DB=dcos`; run the selftest | The selftest is PASS on prod |
| C-P1-07 | 10:30–11:00 | 30m | all P1 | fixes | `uv run pytest -m live -q` against `dcos` after S seeds + injects `pump_fail pump_B` + `ticket_lie pump_B` | The MVP checklist row "`/agent/ask` within 30 s, names #41 vs pump_B, ≥ 4 tool calls" is green. Open the PR `lane/c-agents → main` |

### Phase 2: The hard piece (11:15 PM–3:00 AM)
| ID | Window | Dur | Depends | Files | Commands | DoD + test |
|---|---|---|---|---|---|---|
| C-P2-01 | 11:15–12:45 | 90m | C-P1-04; build on the fixture until S-SIM | `plan_simulate.py`, `tests/test_plan.py` | `uv run pytest tests/test_plan.py -q` | 2–3 candidates + "Do nothing" are each simulated; the ranking is correct; the `decision` payload validates against the `PlanDecision` model (exact §6.1 shape) |
| C-P2-02 | 12:45–1:45 | 60m | C-P2-01, S-SIM live | `execute_verify.py` | Live: inject `pump_fail pump_B` + `load_spike rack_7` on `dcos-dev`, then watch | The incident reaches `resolved` by itself; if verification fails, exactly one replan happens, then `failed` |
| SYNC | 1:30 | — | — | `plans/status/C.md` | 3 lines in `#status` | — |
| C-P2-03 | 1:45–2:30 | 45m | A-FRZ | `prompts.py`, `tools.py` (heat-balance fields) | Inject `sensor_freeze rack_5`, then watch | The hypothesis mentions the rack_5 sensor, and the plan uses *predicted*, not reported, temperature (§5.5) |
| C-P2-04 | 2:30–3:00 | 30m | S-EVAL | `agents/.env.eval` (gitignored by `.env*`) | `uv run python -m dcos_agents.worker --env-file agents/.env.eval` (pointing at `http://localhost:3000`, DB `dcos-eval`) | B's `run_eval.py` sees agent actions on the first 5 scenarios. **A local server issues its own identities:** create a new token with `curl -X POST http://localhost:3000/v1/identity` and have S allow-list it on `dcos-eval` |
| CHECK | 3:00 | — | — | — | With B: pump_fail, ticket_lie, sensor_freeze, real fan | `git tag hard-piece` (S does the tagging) |

### Phase 3: Expansion (3:00–4:30 AM; then sleep 4:30–7:30)
| ID | Window | Dur | Depends | Files | DoD + test |
|---|---|---|---|---|---|
| C-P3-01 | 3:00–3:50 | 50m | C-P2-02 | `worker.py` | **Challenge mode** (§5.7): fail pump_B, then inject `load_spike` mid-plan, and a "replanning: new failure detected" thought plus a new plan decision appear |
| C-P3-02 | 3:50–4:20 | 30m | C-P2-02 | `handoff.py` | A shift note with `verified=true` contains "Ticket #41 is inaccurate" |
| C-P3-03 | 4:20–4:30 | 10m | — | `plans/status/C.md` | Push the branch, **stop Brev**, sleep |

### Phase 4: Polish + demo prep (7:30–10:00 AM)
| ID | Window | Dur | Task | DoD |
|---|---|---|---|---|
| C-P4-01 | 7:30–8:00 | 30m | Restart Brev, rebase, full demo run with everyone | The demo path (PLAN §10) passes |
| C-P4-02 | 8:00–8:30 | 30m | **Fallback drill (P4-C-01):** kill the tunnel mid-`/agent/ask` | `/health` flips to `nvidia-hosted` within 20 s, and the answer still arrives. Check the Brev spend (the $90 rule) |
| C-P4-03 | 8:30–9:15 | 45m | With B: the 2-pump vs 3-pump comparison (P3-B-03). Tune the prompts on the failed eval cases | Two incidents with different chosen plans |
| C-P4-04 | 9:15–9:45 | 30m | Rehearsals; fix only demo-path bugs; last PR by 9:45 | PR merged, `freeze` tagged at 10:00 |
| C-P5-01 | 10:00–10:45 | 45m | `agents/README.md` + the "How Nemotron is used beyond a chatbot" text for S to paste into the root README | S has the text |

---

## 5. Agent design

### 5.1 The 12 tools (names frozen, CONTRACTS §6). Every result is wrapped by `truncate(obj, 4096)`
| Tool | Args (pydantic) | Implementation | Result (additive fields are fine; the names aren't) |
|---|---|---|---|
| `get_facility_topology` | — | `component` + `edge` + `facility` | `{"tick", "components":[{"id","kind","status","params"}], "edges":[{"from_id","to_id","kind"}]}` |
| `get_component_status` | `id: str` | `component` + `telemetry_latest` (one id) | `{"id","kind","status","temp_c","power_kw","cooling_kw","load_kw","sensor_age_s","fan_health","fan_anomaly","fan_online","tick"}` |
| `get_recent_telemetry` | `id: str, n: int = 30 (1..120)` | `telemetry_history WHERE component_id` → sort by tick, keep the last n | `{"points":[{"tick","temp_c","power_kw","cooling_kw"}], "heat_balance": {...}}` (§5.5, racks only) |
| `get_component_dependencies` | `id: str` | `edge`, both directions | `{"upstream":[…], "downstream":[…]}` |
| `get_maintenance_logs` | `id: str` | `ticket WHERE component_id` | `[{"id","title","status","notes","created_tick"}]` |
| `get_shift_notes` | — | `shift_note`, last 10 by `tick` | `[{"id","author","body","verified","tick"}]` |
| `get_active_incidents` | — | `incident`, status ∉ {resolved, failed} (filtered in Python) | `[{"id","symptom","component_ids":[…],"severity","status","hypothesis"}]` |
| `simulate_recovery_plan` | `actions: list[Action], ticks: int = 300` | `proc("simulate_plan", json.dumps(actions), ticks)` | the `Outcome` dict (5 keys) |
| `validate_safety_constraints` | `action: Action` | `call("request_action", kind, target_id, json.dumps(params), requested_by, incident_id)`, then `SELECT * FROM action WHERE incident_id = N`, taking the max `id` matching kind + target | `{"action_id","status","reason","predicted"}` (`reason` = `safety_reason`; keep the `OK:`/`BLOCKED:` prefixes) |
| `execute_simulated_action` | `action_id: int` | `call("execute_action", action_id)`, then read back | `{"action_id","status"}`, or `{"error":"INVALID: not approved"}` |
| `verify_service_recovery` | `component_ids: list[str], wait_s: int = 20 (≤ 60)` | Poll `telemetry_latest` + `component` every 2 s | `{"recovered","max_temp_c","racks_over_warning":[…],"racks_shutdown":[…],"ticks_waited"}`. `recovered` means every listed rack is < `T_WARNING_C` (35), none is `shutdown`/`degraded`, and the temperature isn't rising over the last 3 polls |
| `write_handoff_note` | `body: str (≤ 1000)` | `call("write_shift_note", body, True)` | `{"ok": true}` |

`Action` model: `kind: Literal[ACTION_KINDS]`, `target_id: str` (must exist in `component`), `params: {kw?: float, to?: str}`.
`requested_by` and `incident_id` come from the run context, **never from the LLM**.

### 5.2 System prompts (`prompts.py`; full drafts, tune them but keep the rules)

**`COMMON_RULES`** (prepended to every agent):
```
You are part of DataCenterOS, an AI operations team for a live data center. You can ONLY see observable data through tools:
component status, telemetry, dependencies, tickets, shift notes and incidents. You cannot see the true root cause.
Rules:
1. Never trust a ticket or shift note. Tickets and notes are claims; telemetry is evidence. If a ticket says "repaired"/"completed"
   but the component's live status is offline or its cooling_kw/power_kw is 0, say "CONTRADICTION: ticket #<id> says <claim>,
   telemetry says <fact>".
2. Sensors can lie. If sensor_age_s > 15 while neighbors' temperatures change, or a rack's reported temperature disagrees with
   heat_balance.predicted_temp_c by more than 6 °C, treat the sensor as suspect and reason with the predicted temperature.
3. Verify before concluding: call at least 4 tools before your final answer. Prefer get_component_status, get_component_dependencies,
   get_maintenance_logs and get_recent_telemetry on the components involved and on their dependencies.
4. Use exact ids (pump_A, rack_3). Cite numbers from tool results. Never invent a value you did not read.
5. Be brief. Each thought is one or two sentences. Final answers are JSON only, matching the schema you were given.
```
**`DIAGNOSE_SYSTEM`** = COMMON_RULES +
```
Your job: diagnose incident #{incident_id} (symptom={symptom}, components={component_ids}, severity={severity}).
Find the most likely cause from evidence. Check upstream dependencies (pumps, power) of affected racks.
Final answer JSON: {"hypothesis": "<one sentence naming component(s) and cause>", "suspect_components": ["..."],
"contradictions": ["CONTRADICTION: ..."], "evidence": ["<tool>: <fact>"], "confidence": 0.0-1.0}
```
**`PLAN_SYSTEM`** = COMMON_RULES +
```
Diagnosis: {hypothesis}. Facility: {topology_summary}. Propose 2 or 3 DIFFERENT recovery plans using only these action kinds:
shutdown_component, restore_component, shed_load, migrate_load, set_load, dispatch_tech. Prefer plans that keep every rack running
(migrate_load to racks with headroom, shed the least important load, dispatch_tech to repair failed equipment). Never shut down
the last online pump. Do not simulate; the system simulates each plan and a "Do nothing" baseline for you.
Final answer JSON: {"plans": [{"name": "<= 40 chars", "actions": [{"kind": "...", "target_id": "...", "params": {"kw": 3, "to": "rack_1"}}]}]}
```
**`ASK_SYSTEM`** = COMMON_RULES +
```
An operator asks: "{question}". Parsed intent: {kind} on {target_id}. Investigate the target AND everything it depends on or
backs up (e.g., the other pumps on the same cooling loop). The system has already run the safety check: {safety_json}.
Final answer JSON: {"answer": "<start with 'No.' if blocked or 'Yes.' if approved; then 1-3 sentences naming contradictions and the
predicted impact>", "evidence": ["<source>: <fact>", ...]}
```
**`REPLAN_NOTE`** (appended to PLAN_SYSTEM when replanning): `The previous plan "{name}" was executed but verification failed: {verify_json}. Propose different plans.`

### 5.3 The tool-calling loop (`loop.run_tool_loop(agent, system, user, tools, ctx, final_model)`)
1. `messages = [system, user]`. Repeat for up to `LLM_MAX_STEPS` (8) **LLM calls**. Each call uses `max_tokens=LLM_MAX_TOKENS` (512), `temperature=0.2` and `tool_choice="auto"`.
2. Before each call, check `ctx.cancel` (Challenge mode, §5.7). If it's set, raise `Cancelled`.
3. Strip any reasoning text. If any is left, log it as `kind="thought"`, `summary=text[:280]`, `payload={"text": text[:2000]}`.
4. For each `tool_call`:
   - Log a `tool_call` step: `summary="get_component_status(pump_B)"`, `payload={"args": {...}}`.
   - Validate the args with that tool's pydantic model.
   - Run the tool. Log a `tool_result` step: `summary` is a one-line digest (e.g., `"pump_B status=offline cooling_kw=0"`), `payload={"result": truncated}`.
   - Append the `{"role":"tool", "tool_call_id", "content": json}` message.
5. **Errors** (an unknown tool, bad JSON args, pydantic failure, or a final answer that fails `final_model`):
   - Send the error text back **once** as a tool or user message ("Error: … Fix it and retry").
   - A second error in the same run raises `AgentFailed(reason)`.
   - The caller then calls `update_incident(id, "failed", "<reason>", "")` and logs a `decision` step with `{"error": reason}`.
6. **Final answer:** a message without tool calls. Parse it as JSON (pull out the first `{…}` block) into `final_model`. If fewer than 4 tools have been called, reply once: "Verify with at least 4 tool calls first".
7. **Step budget:** if 8 calls are used up without a final answer, raise `AgentFailed("step budget exhausted")`.
8. **Cost:** every LLM call adds `usage.total_tokens` to the in-process counters `agent_calls += 1` and `agent_tokens += n`. Push them to the `metric` keys `agent_calls`/`agent_tokens` once the contract request `bump_metric` lands (§9, gap 3); until then, expose them in the `/health` extras and the logs.

**`StepLogger`** (`steps.py`):
- Wraps `call("log_agent_step", incident_id, agent, step_no, kind, tool, summary[:280], json.dumps(payload)[:4096])`.
- `step_no` is per incident and increases across all agents. Seed it from `max(step_no)` of the existing rows on restart.
- It truncates on its side even though the reducer truncates too, because the payload must stay valid JSON. If it's too big, replace it with `{"truncated": true, "head": "..."}`.
- A logging failure **never** kills the run. Print it and continue.

### 5.4 Diagnose agent (`detect_diagnose.run(incident)`)
- `update_incident(id, "investigating", "", "")`.
- Run the loop with `DIAGNOSE_SYSTEM` and the diagnose final model (7 read-only tools: topology, status, telemetry, dependencies, maintenance logs, shift notes, active incidents; **no** write tools).
- Log a `decision` step (`agent=diagnose`) with the final JSON.
- `update_incident(id, "planning", hypothesis, "")`. Hand off to plan.

### 5.5 Frozen-sensor reasoning (C-P2-03)
For racks, `get_recent_telemetry` adds a `heat_balance` field computed in Python from **public** data:
- **Predicted temperature:** step `T_pred` forward from the first point, with `dT = (load_kw − cooling_kw)/thermal_mass − PASSIVE_K_PER_S·(T − T_AMBIENT_C)`. `thermal_mass` comes from `component.params_json.thermal_mass_kj_per_c` (default 60).
- `heat_balance = {"predicted_temp_c", "reported_temp_c", "delta_c", "sensor_age_s", "neighbors_changing": bool, "suspect": delta_c > 6 or (sensor_age_s > 15 and neighbors_changing)}`.
- The diagnose prompt rule 2 then leads to a hypothesis like "rack_5 temperature sensor frozen". The plan then includes `dispatch_tech rack_5` and judges safety on the predicted temperature.

### 5.6 Plan agent (`plan_simulate.run(incident, diagnosis)`): the LLM proposes, physics decides
1. The LLM call (`PLAN_SYSTEM`) returns 2–3 plans. Validate them with pydantic, dropping unknown kinds and ids.
2. If fewer than 2 valid plans remain, top up from `fallback_candidates(topology)`. This is deterministic:
   - **(a)** `dispatch_tech` on each offline pump
   - **(b)** `migrate_load` 3 kW from the hottest rack to the coolest
   - **(c)** `shed_load` on the hottest non-real-fan rack
3. Always append `{"name": "Do nothing", "actions": []}`.
4. For each plan: log a `tool_call` step `simulate_recovery_plan`, call it with `ticks=300`, then log a `tool_result` step. Cap: **at most 4 simulations** (3 plans + do nothing).
5. **Ranking:** `sorted(key=lambda p: (o.racks_shutdown, o.downtime_rack_s, o.peak_temp_c))`.
6. Log a `decision` step with `agent="plan"`, `tool=""`, and `payload_json` **exactly**:
   `{"plans":[{"name","actions":[{"kind","target_id","params"}],"outcome":{"min_cooling_margin_kw","peak_temp_c","racks_degraded","racks_shutdown","downtime_rack_s"}}, …], "chosen": <index into plans>, "reason": "<≤ 100 chars, e.g. 'Lowest downtime with no shutdowns'>"}`
   Keep the plans in **proposal order**, with "Do nothing" last; `chosen` points into that list. Validate it with the `PlanDecision` pydantic model before sending.
7. `update_incident(id, "awaiting_approval", hypothesis, json.dumps(chosen_plan))`.
8. Call `validate_safety_constraints` for each action in the chosen plan (`requested_by="agent"`). If **any** is `blocked`, log a thought quoting the `BLOCKED:` reason, mark that plan rejected, and try the next-ranked plan. If every plan is blocked, mark the incident `failed` with "no safe plan".
9. If the chosen plan is "Do nothing" (e.g., a 3-pump facility), log it, call `dispatch_tech` on the offline component if there is one, and go straight to verify.

### 5.7 Execute agent + replan + Challenge mode (`execute_verify.run`, `worker.py`)
- `update_incident(id, "executing", …)`. Call `execute_simulated_action` for each approved `action_id`, in order.
- Then call `verify_service_recovery(component_ids=incident racks + plan targets, wait_s=20)`.
  - **Recovered:** `update_incident(id, "resolved", hypothesis, plan_json)`, then run handoff.
  - **Not recovered:** a single LLM call explains why. Log it as a `thought`, then **replan once** (plan agent with `REPLAN_NOTE`), execute, and verify. If it's still not recovered: `failed`.
- **Worker:**
  - Polls `SELECT * FROM incident` every 1 s. It claims `status='new'` incidents. `operator_question` incidents are handled by `/agent/ask`, never by the worker.
  - It runs **one pipeline at a time** (a global run lock), and won't rerun the same incident within 10 s.
  - `POST /agent/run/{id}` queues a manual rerun.
- **Challenge mode (C-P3-01):**
  1. If a new incident Y appears while run X is in `planning`, `awaiting_approval` or `executing`, the worker sets `X.cancel`.
  2. The run stops at its next check: before an LLM call, before each `execute_simulated_action`, and between verify polls. Approved actions it hasn't executed yet are **never executed**.
  3. It logs `thought` on X: "replanning: new failure detected (incident #Y, <symptom> on <ids>)".
  4. It sets X back to `investigating`, then re-runs diagnose → plan → execute on **X**, with Y's symptom and components merged into the context. That way the replan shows up on the incident that's already on screen.
  5. Y is set to `investigating` with the hypothesis "handled with incident #X", and resolved together with X.

### 5.8 Handoff writer (`handoff.py`, C-P3-02): deterministic, so it's really "verified"
- Build the body only from tool results gathered **at write time**:
  - it re-reads `get_component_status` for every component mentioned
  - it re-reads `get_maintenance_logs` for those components
- Template: `"[Verified by agents @ tick {t}] {resolved summary}. Live state: pump_B offline (cooling_kw=0), pump_A online. Ticket #41 is inaccurate: it says 'Replaced impeller, pump back online' but telemetry shows pump_B offline. Shift note '{note}' is unverified. Actions taken: {plan name}. Next: tech dispatched to pump_B."`
- Mention a ticket as inaccurate **only if** the contradiction check holds at write time.
- `write_handoff_note(body)` with `verified=true`, plus a `decision` step with `agent="handoff"`.

### 5.9 `/agent/ask` flow (`ask.py`): target ≤ 30 s, returns CONTRACTS §5 exactly
1. `parse_operator_question(q)` → `(kind, target_id)`.
   - Kind: a regex maps `shut ?down|turn off|power off|take .* (down|offline)|offline|maintenance` to `shutdown_component`, and `restore|bring back|turn on` to `restore_component`.
   - Target: the ids are normalized: `pump[\s_]*([a-z])\b` or `\b([a-z]) pump` → `pump_A`; `rack[\s_]*(\d+)` → `rack_3`; `ups[\s_]*(\d+)`; `util(ity)?[\s_]*(\d+)`. Check the result against `component`.
   - If no match: one LLM call with JSON output; if that still fails, return the answer "I couldn't tell which component you mean." with `action_id: 0`.
2. Create the incident with symptom `operator_question`, component_ids=`target_id`, severity `high`. **This needs a contract addition** (§9, gap 1: `open_incident`). Until then, run with `incident_id=0`, and D shows the steps under "Operator question".
3. Call `validate_safety_constraints({"kind","target_id","params":{}})` with `requested_by="operator"`. This writes the real `action` row, so D's operator panel shows it as `blocked`.
4. Run the loop with `ASK_SYSTEM` (the safety result is in the prompt; read-only tools; ≥ 4 tool calls). The agent should visit `pump_A` → its dependencies → `pump_B` → ticket #41 → telemetry.
5. **Consistency guard:**
   - If the action is `blocked`, the answer must start with "No.". If it's `approved`, it must start with "Yes.".
   - The evidence must include a `ticket #` item when there's a contradiction.
   - Otherwise, replace the answer with a template built from the tool results: `"No. Pump B is offline even though ticket #41 says it was repaired. Shutting down Pump A drops cooling to 0 kW; simulation predicts 8 racks shut down."`
6. Log a `decision` step with `agent="diagnose"`, then `update_incident(id, "resolved", <answer[:280]>, "")`.
7. Return `{"incident_id", "answer", "action_id", "action_status", "evidence"}`.
**If the LLM is fully down,** steps 1, 3 and 5 still produce a correct, honest answer from tools alone. Log the thought "LLM unavailable: deterministic answer".

### 5.10 `/health`
`{"ok": true, "llm": <current provider>, "model": <model id>, "stdb": "ok"|"error"}`. `stdb` comes from a cached `SELECT * FROM facility` taken at most every 5 s. Extra keys (`agent_calls`, `agent_tokens`, `fallbacks`) are allowed only if S accepts them as additive (§9).

---

## 6. Tests (`uv run pytest -q` must pass in fixture mode; `-m live` before each PR)
| File | Test | Asserts |
|---|---|---|
| `test_stdb.py` | `test_zip_rows`, `test_u64_strings_become_int`, `test_some_wrapped_names`, `test_error_raises_stdberror`, `test_no_retry_on_forbidden` | via `httpx.MockTransport`; no network |
| `test_tools.py` | `test_schemas_valid` (12 names == the CONTRACTS §6 list; each `parameters.type == "object"`), `test_each_tool_shape` (parametrized over the 12 tools, checking the keys in §5.1), `test_truncation_4kb`, `test_bad_args_rejected`, `test_action_model_rejects_unknown_kind` | fixture mode |
| `test_tools.py` | **`test_private_table_denied`**: `sql("SELECT * FROM ground_truth")` and `failure` both raise `StdbError` | fixture **and** `@pytest.mark.live` (the live one is the real security proof) |
| `test_loop.py` | scripted `FakeLLM`: `test_max_8_steps`, `test_one_retry_then_success`, `test_two_errors_fail_incident`, `test_every_step_logged`, `test_min_4_tools_nudge`, `test_cancel_raises` | `FixtureStdb.calls` contains the expected `log_agent_step` rows |
| `test_plan.py` | `test_ranking_order`, `test_do_nothing_always_present`, `test_decision_payload_exact_shape` (`PlanDecision` + a key-set equality check against the §6.1 example), `test_blocked_plan_falls_to_next` | pure + fixture |
| `test_ask.py` | **`test_pump_a_acceptance`**: state = pump_B offline + ticket #41 completed. Asserts `action_status=="blocked"`, `"41" in answer`, `"pump_B" in answer or "Pump B" in answer`, `len(evidence) >= 2`, ≥ 4 `tool_call` steps logged | fixture with FakeLLM; **live** with the real LLM on `dcos-dev`/`dcos` |
| `test_ask.py` | **`test_paraphrases`** (parametrized): "Can I shut down Pump A for maintenance?" · "Is it safe to take pump a offline right now?" · "I need to power off PumpA for the bearing check, ok?" · "ok to put pump_A into maintenance mode?" · "Should I turn off the A pump?" | each one parses to `("shutdown_component","pump_A")`; **live:** each one gives `blocked` + mentions #41 (PLAN §10: C tests 5 phrasings) |

`conftest.py` sets `STDB_MODE=fixture` unless you pass `-m live`. `pyproject.toml` registers the marker: `[tool.pytest.ini_options] markers = ["live: needs STDB + LLM"]`.

---

## 7. Fallbacks, with decision deadlines
| Problem | Early warning | Fallback | Deadline |
|---|---|---|---|
| Brev NIM won't deploy | No `tool_calls` by 6:00 PM | `nvidia-hosted` becomes the primary; keep Brev as stretch | **6:00 PM** |
| NIM is slow | > 10 s per call, or `/agent/ask` > 30 s | Turn reasoning off (check model card); cut diagnose to 6 steps; the hosted API | 9:00 PM |
| Bad tool calls (wrong names, broken JSON) | `test_ask` live fails twice | (1) tighten the prompt with examples; (2) `tool_choice` forced for the first call; (3) **`find_contradictions()`**: a deterministic helper that compares tickets/notes against `component.status` + telemetry, and returns `[{"ticket_id","claim","fact"}]` plus sensor suspects. Use it internally at once (ask guard, handoff); expose it as a **13th tool** only after S accepts contract request gap 4 | **10:30 PM** (PLAN §8) |
| Planner too slow | > 60 s per incident | 2 plans + do nothing, `ticks=120`, and run the `simulate_plan` calls in a thread pool | 1:00 AM |
| `simulate_plan` not ready | S-SIM slips past 1:00 AM | The planner still runs on `validate_safety_constraints` (`predicted_json`) as its outcome source, labeled honestly in the reason | 1:00 AM |
| u64 arrives as strings | selftest check 3 | `stdb.sql` coercion (already built); worst case S adds f64 mirrors | 6:00 PM |
| Maincloud down | `/health` `stdb:"error"` | `STDB_HOST=http://localhost:3000` + a local identity (as in C-P2-04) | any time; practiced at 7:30 AM |
| Brev credit burn | > $90 by 8 AM | Stop between rehearsals; judge on hosted | 8:00 AM |

---

## 8. Parallel build with Claude Code sub-agents (optional, recommended)

**First, 5 minutes, you do this yourself:** commit C-P0-01 (the stubs with final function signatures) to `lane/c-agents`. Git can't hold a branch `lane/c-agents` **and** branches named `lane/c-agents/…` (the ref names collide), so the worktree branches use a `wt/` prefix:
```bash
git checkout lane/c-agents && git pull
git worktree add ../dcos-c1 -b wt/c1-stdb    lane/c-agents
git worktree add ../dcos-c2 -b wt/c2-llm     lane/c-agents
git worktree add ../dcos-c3 -b wt/c3-tools   lane/c-agents
git worktree add ../dcos-c4 -b wt/c4-agents  lane/c-agents
# merge back (you, in the main tree, in this order): C-1, C-2, C-3, C-4
git merge --no-ff wt/c1-stdb && (cd agents && uv run pytest -q)
git worktree remove ../dcos-c1   # after merging
```
Open one Claude Code session per worktree directory, and paste the prompt below into each. **Common footer for every prompt:**
> Read `plans/CONTRACTS.md` and `plans/LANE-C-agents.md` first; CONTRACTS wins. Python 3.12 with uv inside `agents/`. Hackathon mode: working beats elegant, tests only where listed. **Must not:** edit files outside your Owns list, change any function signature in the stubs, add packages (put requests in your report), commit secrets, or touch `plans/CONTRACTS.md`. Commit small (`feat(c): …`) on your worktree branch only. **Report:** files changed, test commands + results, open questions, requested deps or contract changes.

**C-1: stdb client + fixture + selftest + constants** (start 4:50 PM)
> Goal: the SpacetimeDB HTTP layer that Lanes C and A import. **Owns:** `agents/dcos_agents/{constants,config,stdb,fixture_stdb,selftest}.py`, `agents/tests/{conftest,test_stdb}.py`, `agents/tests/data/mini_rows.json`. Implement CONTRACTS §4 exactly (`sql`, `call`, `proc`, `StdbError`), plus LANE-C §3: u64 coercion, `{"some":…}` column names, a proc string re-parse, retries only on network errors and 5xx, the SQL style rule, `STDB_MODE=fixture` switching to `FixtureStdb` (private tables raise FORBIDDEN; heuristic `request_action`/`simulate_plan`). Copy CONTRACTS §1 into `constants.py` verbatim. `selftest.py` prints PASS/FAIL for the 4 checks in C-P0-03 (+ an LLM ping, if `llm.ping` exists) and exits non-zero on failure. **Done when:** `STDB_MODE=fixture uv run pytest tests/test_stdb.py -q` passes and `uv run python -m dcos_agents.selftest` runs (against `dcos-dev` if `.env.local` exists).

**C-2: llm.py + Brev runbook** (start 4:50 PM)
> Goal: one `chat(messages, tools, max_tokens=None) -> ChatResult(message, usage, provider, latency_s)` function with the provider chain in LANE-C §2.7. **Owns:** `agents/dcos_agents/llm.py`, `agents/tests/test_llm.py`, `agents/BREV.md`. Use the `openai` SDK; one client per provider; fail over after 2 consecutive errors or a call > 20 s; sticky, with a 60 s background re-probe of provider 1; strip `<think>…</think>` and `reasoning_content`; count calls and tokens in module counters; `current_provider()` / `current_model()` for `/health`; `python -m dcos_agents.llm --ping` sends the §2.5 tool-call test. Tests use a fake OpenAI client (no network): failover on errors, failover on latency, reasoning stripping. Write `BREV.md` from LANE-C §2 with **TODO: check model card** placeholders; don't invent docker flags. **Done when:** `uv run pytest tests/test_llm.py -q` passes.

**C-3: tools + tests against fixtures** (start 5:45 PM; needs C-1's stub signatures only)
> Goal: the 12 frozen tools from CONTRACTS §6 with the shapes in LANE-C §5.1. **Owns:** `agents/dcos_agents/tools.py`, `agents/tests/test_tools.py`. Pydantic arg models; `TOOL_SCHEMAS` (OpenAI function format); `dispatch(name, args, ctx) -> dict`, where `ctx` carries `incident_id` + `requested_by` (never taken from the LLM); `truncate(obj, 4096)`; `heat_balance` for racks (§5.5); `find_contradictions()` as an internal helper function, **not** registered as a tool. Use only `stdb.sql/call/proc`. **Done when:** `STDB_MODE=fixture uv run pytest tests/test_tools.py -q` passes all the rows in LANE-C §6 for `test_tools.py` (live tests marked `@pytest.mark.live`).

**C-4: loop + agents + worker + API** (start 6:30 PM; codes against the C-1/C-2/C-3 stubs)
> Goal: the agent pipeline and service. **Owns:** `agents/dcos_agents/{steps,loop,prompts,detect_diagnose,plan_simulate,execute_verify,handoff,ask,worker,api}.py`, `agents/tests/{test_loop,test_plan,test_ask}.py`. Implement LANE-C §5.2–5.10 exactly: the loop rules, the exact §6.1 decision payload validated by a `PlanDecision` model, ranking `(racks_shutdown, downtime_rack_s, peak_temp_c)`, one replan, Challenge-mode cancel, a deterministic handoff, the `/agent/ask` consistency guard, CORS `*`, `python -m dcos_agents.api [--no-worker] [--port 8787]`, `python -m dcos_agents.worker [--env-file]`. Test with a scripted `FakeLLM` in fixture mode. **Done when:** `STDB_MODE=fixture uv run pytest tests/test_loop.py tests/test_plan.py tests/test_ask.py -q` passes, and `curl -X POST localhost:8787/agent/ask …` returns the CONTRACTS §5 shape in fixture mode.

---

## 9. Contract gaps found (send these as `CONTRACT C: …` issues to S; don't edit CONTRACTS)
1. **No reducer lets the agents create an incident**, but `/agent/ask` must "create an incident with symptom `operator_question`" (§5). Request: `open_incident(symptom: string, component_ids: string, severity: string)`, roles `agent`. C reads the new id back via `SELECT * FROM incident WHERE symptom = 'operator_question'` (max id).
2. **Reducers return nothing,** so `request_action` gives C no `action_id`. C reads back the max `action.id` for `incident_id` + kind + target. Request: S confirms this is OK, or adds an `action.request_key: string` column (default `""`) to match on.
3. **No way for agents to write metrics,** yet `agent_calls`/`agent_tokens` are metric keys. Request: `bump_metric(key: string, delta: f64)`, roles `agent`, restricted to those two keys.
4. **`find_contradictions()` as a 13th tool** (additive; the UI shows a new chip name). Request it by 10:30 PM only if the live Pump A test is flaky.
5. **The `simulate_plan` `actions_json` element shape is ambiguous:** PLAN §3.5 shows `params_json` (a string), while CONTRACTS §2/§6 use `params` (an object). C sends `[{"kind","target_id","params":{…}}]`. Request: S states this in §3.3. Also confirm whether the procedure's HTTP body is the Outcome object or a JSON string (C handles both).
6. **The branch naming in §11 can't work:** `lane/c-agents/stdb` can't coexist with the branch `lane/c-agents`. Request: document the `wt/<lane>-<name>` worktree branch names.
7. **The LLM fallback config has no env names:** there's no frozen name for the hosted model id or the local llama.cpp URL. Request: additive `NVIDIA_HOSTED_MODEL`, `LLM_LOCAL_BASE_URL`, `LLM_LOCAL_MODEL` (with defaults).
8. **`README.md` is S-owned, but PLAN P5-C-01 gives C the README.** Resolution: C writes `agents/README.md` plus a text block, and S pastes it.
9. **Optional `/health` extras** (`agent_calls`, `agent_tokens`, `fallbacks`) for D's StatsBar: an additive response field.

---

## 10. Lane time estimate
| Block | Solo person-hours | With 4 sub-agents (wall clock) | Milestone deadline |
|---|---|---|---|
| P0 (scaffold, Brev, stdb, llm) | 3.0 h | 1.0 h | **5:45 PM** (Brev go/no-go **6:00 PM**) |
| P1 (fixture, tools, loop, diagnose, ask, API, worker, prod) | 6.0 h | 3.5 h | tools **7:00 PM**, ask in fixture **9:00 PM**, prod **11:00 PM** |
| P2 (planner, execute/verify, frozen sensor, eval hookup) | 4.5 h | 3.0 h | planner **12:45 AM**, auto-resolve **1:45 AM**, eval worker **3:00 AM** |
| P3 (Challenge mode, handoff) | 1.5 h | 1.0 h | **4:30 AM**, then sleep |
| P4 (hardening, comparison, rehearsals) | 2.5 h | 2.5 h | last PR **9:45 AM**, freeze **10:00 AM** |
| **Total** | **~17.5 h** | **~11 h** (fits the 4:45 PM → 4:30 AM + 7:30 → 10:00 AM windows, with ~1.5 h of slack) | |
**If behind at 1:30 AM:** cut in this order: frozen-sensor prompt polish → Challenge mode (video only, PLAN §9 #8) → the LLM step of the replan (keep the deterministic replan). **Never cut:** `/agent/ask` on Pump A, live agent steps, the planner's 3 simulated plans.

---

## 11. Status template: `plans/status/C.md` (update at every sync)
```markdown
# Lane C status: <time>
- **LLM:** provider=<brev-nim|nvidia-hosted|local> · model=<id> · Brev $/hr=<x> · spend so far=$<y> · instance=<running|stopped>
- **STDB:** host=<url> db=<dcos-dev|dcos|dcos-eval> · selftest=<PASS 5/5 | FAIL: …>
- **Done:** C-P?-?? …
- **In progress:** C-P?-?? (ETA hh:mm)
- **Blocked on:** <lane + task id, or "none">
- **Tests:** fixture <n passed>/<n> · live <n passed>/<n> · Pump A acceptance <PASS/FAIL> · paraphrases <k/5>
- **Contract requests open:** <#issue list>
- **Model card notes:** image=<…> · tool-call flag=<…> · reasoning toggle=<…> · hosted id=<…>
```

## 12. PR checklist (`lane/c-agents → main`, only at sync points; S merges)
- [ ] `git fetch && git rebase origin/main`, with no conflicts outside `agents/**`
- [ ] `cd agents && uv run ruff check . && uv run pytest -q` (fixture) is green
- [ ] `uv run pytest -m live -q` is green against the target DB (or failures listed in the PR body with a reason)
- [ ] `uv run python -m dcos_agents.selftest` passes all checks, **including the private-table-denied check**
- [ ] No secrets: `git diff origin/main -- agents | grep -iE "nvapi-|eyJ|token="` is empty; `.env.local`/`.env.eval` are not tracked
- [ ] The 12 tool names match CONTRACTS §6 exactly; the decision payload matches §6.1 (`test_decision_payload_exact_shape`)
- [ ] `/health`, `/agent/ask`, `/agent/run/{id}` match CONTRACTS §5 (curl output pasted in the PR)
- [ ] `stdb.py` public signatures are unchanged (Lane A depends on them)
- [ ] Commits are `feat(c): …` / `fix(c): …`; after 10:00 AM only `fix(demo): …`, approved by Suvan
- [ ] `plans/status/C.md` is updated, and any new contract requests are filed as issues
