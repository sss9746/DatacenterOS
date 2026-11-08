# DataCenterOS implementation kit — v1.1.0 (four software developers)

**Read in order:**

1. `ARCHITECTURE.md` — full research-backed system design, runtime ownership, concurrency, durability, model/clock semantics, evaluation.
2. `CONTRACTS.md` — logical SpacetimeDB schema/table/index/reducer contracts and cross-team handoffs.
3. `contracts.schema.json` — canonical Draft 2020-12 JSON Schema for cross-service payloads (`#/$defs`).
4. `example-payloads.json` — five validated payload examples (telemetry, hardware, command, job, private fault).
5. `IMPLEMENTATION_TASKS.md` — exact task split for **four software developers** (simulation/safety, SpacetimeDB/durability, Nemotron/orchestration, frontend/evaluation). **Hardware is shared and optional**, integration gates and tests.
6. `validate_contracts.py` — schema/sample validator; run with `pip install jsonschema && python validate_contracts.py`.

**Technology recommendation:** pure TypeScript `@dcos/physics`, SpacetimeDB TS module and generated SDK bindings, Node.js orchestrator using NVIDIA NIM tool calling, React dashboard. Later, the whole team can integrate a hardware ESP32/MPU-6050 bridge that sends canonical observations. Use source-labeled, simulated defaults; don't present estimates as measurements.

**Source of truth:** `contracts.schema.json` for wire payloads; SpacetimeDB module schema/generated bindings for DB row/reducer types. To avoid type drift, generate TS wire types from JSON Schema using a schema-to-TypeScript generator during build, and use the SpacetimeDB CLI to generate DB bindings. Do not copy/paste hand-maintained duplicate types.

**Status:** design deliverables with JSON schema+fixtures mechanically validated, not verified against your existing Git repo (the existing `@dcos/physics`, broad `CONTRACTS.md`, and 95 tests were described in your supplied planning file but not provided for source-code inspection).

**Revision from v1.0:** staffing/task assignments and handoff ownership updated. Wire schema remains `1.0.0`; no payload field or reducer contract changes were required.
