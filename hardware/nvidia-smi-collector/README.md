# nvidia-smi collector (track G / F-NV2)

Streams a real Brev GPU's `nvidia-smi` readings into DataCenterOS as **`gpu-real-0`** (observation only; never allocated, capped or mutated). Spec: `plans/team/REAL-GPU.md`.

```bash
# from the repo root; host alias comes from `brev refresh` (default --host dcos-gpu)
# no `--` after `start`: pnpm passes it through and the flags after it are ignored
pnpm --filter nvidia-smi-collector start --dry-run                          # print TelemetryEvent JSON, no DB
pnpm --filter nvidia-smi-collector start --dry-run --record ../recordings/brev-l40s.jsonl
pnpm --filter nvidia-smi-collector start --db dcos-dev                      # live (needs STDB_URI + STDB_GATEWAY_TOKEN in .env.local)
pnpm --filter nvidia-smi-collector start --db dcos-dev --replay ../recordings/brev-l40s.jsonl   # source_kind:"replay", labeled REPLAY OF REAL RECORDING
pnpm --filter nvidia-smi-collector start --db dcos-r-local                  # private local DB; uses ~/.dcos-tokens/dcos-r-local.local.env only
pnpm --filter nvidia-smi-collector start --db dcos-r-local --fake           # invented numbers labeled FAKE TEST GPU; refused for any other DB
pnpm --filter nvidia-smi-collector test
```

- Events go to stdout (dry-run); a one-line summary per second goes to stderr.
- `[N/A]` fields are skipped, never sent as 0. Utilization is sent as a 0–1 ratio.
- The throttle-reason field (`clocks_event_reasons` vs `clocks_throttle_reasons`) is detected once at startup.
- `source_seq` is seeded from `Date.now()` and keeps increasing across SSH reconnects (1 s → 30 s backoff).
- Load: `ssh dcos-gpu "~/dcos-venv/bin/python ~/load.py --seconds 60"` after copying `hardware/brev/load.py` (hard max 120 s). `torch` is installed in that virtual environment because the box has no system `pip`.
- `--record` needs its folder to exist already. Make it first with `mkdir -p hardware/recordings`.
- For prod, `.env.local` holds the dev gateway token, so set the prod `STDB_GATEWAY_TOKEN` in the shell, or replace it in the box's `.env.local`; real environment variables win over `.env.local`.
- The DB client doesn't reconnect, so the collector exits with code 1 when batches go undelivered for 20 s. Run it in a restart loop.
- Run only one collector at a time; two share a `source_id` and reject each other's batches.

## Running on the Brev box

The box needs only tracked code and the two env values, so no GitHub credentials or other secrets go there. From the Mac, at the repo root:

```bash
git archive origin/int/r-sprint | ssh dcos-gpu 'mkdir -p ~/DatacenterOS && tar -x -C ~/DatacenterOS'   # use origin/main for prod
ssh dcos-gpu 'cd ~/DatacenterOS && pnpm install --frozen-lockfile && pnpm --filter @dcos/physics build'
grep -E '^STDB_(URI|GATEWAY_TOKEN)=' .env.local | ssh dcos-gpu 'umask 077; cat > ~/DatacenterOS/.env.local'
```

On the box, `~/.ssh/config` maps `dcos-gpu` to `127.0.0.1`, so `--host dcos-gpu` works unchanged. Start and stop it with:

```bash
tmux new-session -d -s collector -c ~/DatacenterOS 'while true; do pnpm --silent --filter nvidia-smi-collector start --host dcos-gpu --db dcos-dev 2>&1 | tee -a ~/collector.log; sleep 3; done'
tmux kill-session -t collector
```
