# fan-gateway

Physical fan stall (Pico 2 W) - **demo rule**. The Pico (`hardware/pico/main.py`) prints `SPINNING` or
`STOPPED` every ~100 ms over USB serial. When `STOPPED` holds for 1 s (or 10 lines), this gateway calls the
same admin `injectFault` the presenter's pump fault button sends: `cooling_pump_degradation` on `pump-a`,
severity 0.6 (`capacity_factor` 0.4), starting next tick. The dashboard and agent then react as they do to a
live presenter fault. Honest label: the motor is not modeled by physics; a real stall is mapped by rule to a
simulated cooling fault.

Recovery: the DB has no clear-fault reducer, so a sustained `SPINNING` only logs; the agent/dashboard handle
recovery. Serial is read via PowerShell `System.IO.Ports.SerialPort` (no npm deps) and reconnects with 1-10 s
backoff. Only `--db dcos-dev` is accepted. Reads `STDB_URI` + `STDB_ADMIN_TOKEN` from `--env` (default: the
main checkout's `.env.local`); tokens are never printed.

```sh
pnpm --filter fan-gateway test
printf 'STOPPED\n%.0s' {1..15} | pnpm --silent --filter fan-gateway start -- --dry-run --stdin
pnpm --filter fan-gateway start -- --port COM7 --dry-run        # close Thonny first
pnpm --filter fan-gateway start -- --port COM7 --db dcos-dev    # live; post "taking dev" first
```
