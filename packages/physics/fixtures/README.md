# @dcos/physics fixtures (CONTRACTS §9). Lane S owns these; C and D mock against them.
- `facility_default.json`: `compileTopology(defaultDemoConfig()).state` (12 components, 27 edges, rack_3 = real fan).
- `rows_public.json`: one key per CONTRACTS §3.1 public table (snake_case, u64 as numbers, `*_json` as JSON strings), scenario "pump_B failed + ticket lie + operator asked about pump_A" at tick 300. Values are hand-written (22.0 °C steady, margin +2 kW) until `step` lands.
- `agent_steps_example.json`: the 10 `agent_step` rows for incident 12, incl. the CONTRACTS §6.1 plan decision payload. `presets/`: builder presets + `warnings.json`.
- Regenerate: `pnpm -F @dcos/physics build && node --experimental-strip-types packages/physics/scripts/make-fixtures.ts` (then `pnpm -F @dcos/physics test` checks the column sets).
