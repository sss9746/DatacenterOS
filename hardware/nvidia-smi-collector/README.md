# nvidia-smi collector (track G / F-NV2)

Streams a real Brev GPU's `nvidia-smi` readings into DataCenterOS as **`gpu-real-0`** (observation only; never allocated, capped or mutated). Spec: `plans/team/REAL-GPU.md`.

```bash
# from the repo root; host alias comes from `brev refresh` (default --host dcos-gpu)
pnpm --filter nvidia-smi-collector start -- --dry-run                       # print TelemetryEvent JSON, no DB
pnpm --filter nvidia-smi-collector start -- --dry-run --record ../recordings/brev-l4.jsonl
pnpm --filter nvidia-smi-collector start -- --db dcos-dev                   # live (needs STDB_URI + STDB_GATEWAY_TOKEN in .env.local)
pnpm --filter nvidia-smi-collector start -- --db dcos-dev --replay ../recordings/brev-l4.jsonl   # source_kind:"replay", labeled REPLAY OF REAL RECORDING
pnpm --filter nvidia-smi-collector test
```

- Events go to stdout (dry-run); a one-line summary per second goes to stderr.
- `[N/A]` fields are skipped, never sent as 0. Utilization is sent as a 0–1 ratio.
- The throttle-reason field (`clocks_event_reasons` vs `clocks_throttle_reasons`) is detected once at startup.
- `source_seq` is seeded from `Date.now()` and keeps increasing across SSH reconnects (1 s → 30 s backoff).
- Load: `ssh dcos-gpu 'python3 load.py --seconds 60'` after copying `hardware/brev/load.py` (hard max 120 s).
