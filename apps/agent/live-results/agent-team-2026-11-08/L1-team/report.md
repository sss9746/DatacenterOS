# R5 live recovery harness report

- **Result:** PASS (1/1 cases)
- **Commit:** `1dd61b4e3b8e4d10b7f907baabe3d93e4f15cb6f-dirty` (Prod-Multi-Agent-System)
- **Database:** `dcos-r-local` run `run-demo-1` preset `gpu_demo_8` seed 42 speed 2; reset performed: yes
- **Model:** nvidia/nemotron-3.5-lightning-30b-a3b (live_nim)
- **Team mode:** multi
- **Started:** 2026-11-08T12:55:44.438Z on darwin MacBook-Pro-8.local v22.23.4

| Case | Result | Evidence | Sim window | Wall s | Checks |
|---|---|---|---|---|---|
| L1 SIGKILL during checkpoint; fresh process reclaims | PASS | live DB + real agent process + live NIM [team mode: multi] | 601s → 811s | 105 | 12/12 |

## L1 — SIGKILL during checkpoint; fresh process reclaims: PASS

**Command keys:** checkpoint=`wf-inc-thermal-pump-a-b2:checkpoint:job-a:1`, final_migrate=`wf-inc-thermal-pump-a-b2:migrate_restart:job-a:1`

**Checkpoints (job-a):** complete 1 → 2
**Allocation uniqueness:** ok
**Verification:** `{"verified":true,"escalate":false,"handoff":"Recovery verified. job-a checkpoint ckpt-job-a-2 complete+accessible, durable 86400→95776 wu [wf-inc-thermal-pump-a-b2:checkpoint:job-a:1]. job-a running on 16 GPUs in rack-r1,rack-r5; progress 95792→95952 wu over 10000 sim-ms; headroom ≥14.8 C [wf-inc-thermal-pump-a-b2:migrate_restart:job-a:1]. Still open: pump-a degraded (est. 9600/24000 W): needs human service. Next: service pump-a.","as_of_sim_time_ms":811000,"version":1,"source":"code","outcome":"recovered","verification_interval_sim_ms":[801000,811000],"evidence":{"incident_ids":["inc-thermal-pump-a-b2"],"hypotheses":["inc-thermal-pump-a-b2: Cooling pump-a degraded — deterministic grouping (LLM unavailable): 2 symptom(s) share degraded provider pump-a degraded"],"decision_epoch":5,"max_gpu_evidence_age_sim_ms":0},"affected_jobs":[{"job_id":"job-a","status":"running","progress_work_units":95952,"durable_work_units":95776,"racks":["rack-r1","rack-r5"]}],"actions":{"completed":["wf-inc-thermal-pump-a-b2:checkpoint:job-a:1","wf-inc-thermal-pump-a-b2:migrate_restart:job-a:1"],"verified":["wf-inc-thermal-pump-a-b2:checkpoint:job-a:1","wf-inc-thermal-pump-a-b2:migrate_restart:job-a:1"],"unverified":[],"blocked":[],"failed":[],"not_run":[]},"checkpoint_outcome":[{"job_id":"job-a","checkpoint_id":"ckpt-job-a-2","status":"complete","accessible":true,"progress_work_units":95776}],"placement_outcome":[{"job_id":"job-a","gpu_ids":["gpu-r1-n1-0","gpu-r1-n1-1","gpu-r1-n1-2","gpu-r1-n1-3","gpu-r1-n1-4","gpu-r1-n1-5","gpu-r1-n1-6","gpu-r1-n1-7","gpu-r5-n1-0","gpu-r5-n1-1","gpu-r5-n1-2","gpu-r5-n1-3","gpu-r5-n1-4","gpu-r5-n1-5","gpu-r5-n1-6","gpu-r5-n1-7"],"racks":["rack-r1","rack-r5"]}],"unresolved_infrastructure":["pump-a degraded (est. 9600/24000 W): needs human service"],"remaining_risk":"forecast assumes the observed degradation persists and no hidden faults","next_human_action":"service pump-a","checks":[{"command_key":"wf-inc-thermal-pump-a-b2:checkpoint:job-a:1","operation":"checkpoint","ok":true,"note":"job-a checkpoint ckpt-job-a-2 complete+accessible, durable 86400→95776 wu"},{"command_key":"wf-inc-thermal-pump-a-b2:migrate_restart:job-a:1","operation":"migrate_restart","ok":true,"note":"job-a running on 16 GPUs in rack-r1,rack-r5; progress 95792→95952 wu over 10000 sim-ms; headroom ≥14.8 C"}]}`
**Team:** 1 round(s) shown; Lead decided 1, fell back to deterministic code 0
**Provenance:** configured nvidia/nemotron-3.5-lightning-30b-a3b (live_nim); events nemotron=8 code=7 fallback_notices=1; log nemotron_ok=0 nemotron_failed=0 endpoint_failovers=0; team models=[nvidia/nemotron-3.5-lightning-30b-a3b] lead=1 fallback=0

```
PASS  DB sim clock advances without the agent          645000 -> 647000 in 827 ms wall, agent alive=false
PASS  checkpoint completed by the DB while the agent was dead ckpt-job-a-2 complete at sim 676000; agent alive=false
PASS  workflow reclaimed by fresh process              owner agent-MacBook-Pro-8.local-11156 -> agent-MacBook-Pro-8.local-11228, token 1 -> 3, attempt 1 -> 2
PASS  checkpoint completed exactly once                complete_for_key=1 writing_for_key=0 failed_for_key=0 new_complete_for_job-a=1
PASS  same accepted command keys reconciled            1 keys retained, 1 added
PASS  no GPU allocated to two jobs                     32 allocation rows, all unique
PASS  migrate succeeded and job-a runs on its destination wf-inc-thermal-pump-a-b2:migrate_restart:job-a:1: succeeded; job-a running on [gpu-r1-n1-0,gpu-r1-n1-1,gpu-r1-n1-2,gpu-r1-n1-3,gpu-r1-n1-4,gpu-r1-n1-5,gpu-r1-n1-6,gpu-r1-n1-7,gpu-r5-n1-0,gpu-r5-n1-1,gpu-r5-n1-2,gpu-r5-n1-3,gpu-r5-n1-4,gpu-r5-n1-5,gpu-r5-n1-6,gpu-r5-n1-7]
PASS  workflow verified and closed (done)              done
PASS  team: Lead decided                               1/1 round(s) decided by the Lead
PASS  team: specialist answer consumed by a role       wf-inc-thermal-pump-a-b2:a1:e1:m5 workload -> [cooling,lead]; wf-inc-thermal-pump-a-b2:a1:e1:m6 cooling -> [lead]
PASS  team: at most 6 model calls per round            max 5 calls across 1 round(s)
PASS  team: covers recorded with their roles           no cover occurred
```

**Agent processes:** gen1 pid 11156 (SIGKILL); gen2 pid 11228 (stopped_by_harness)

<details><summary>Timeline</summary>

```
2026-11-08T12:55:45.753Z sim=- controlled reset done {"sim_time_after_ms":601000,"tick_index":1,"gpus":64,"jobs":3,"actions":0,"speed":2}
2026-11-08T12:55:45.754Z sim=601000 case start {"sim_time_ms":601000,"speed":2}
2026-11-08T12:55:45.757Z sim=601000 agent generation 1 spawned {"pid":11156,"no_llm":false,"nim_override":null,"team_mode":"multi"}
2026-11-08T12:55:45.779Z sim=601000 injected pump-a degradation 0.6 {"fault_id":"l1-pump-601000","start_sim_time_ms":602000}
2026-11-08T12:56:07.780Z sim=645000 checkpoint running {"command_key":"wf-inc-thermal-pump-a-b2:checkpoint:job-a:1","due_sim_time_ms":null,"waited_ms":22001}
2026-11-08T12:56:07.796Z sim=645000 agent generation 1 killed {"pid":11156,"how":"SIGKILL","waited_ms":15,"sim_at_kill":645000}
2026-11-08T12:56:23.622Z sim=677000 agent generation 2 spawned {"pid":11228,"no_llm":false,"nim_override":null,"team_mode":"multi"}
2026-11-08T12:56:24.743Z sim=679000 workflow reclaimed {"workflow_id":"wf-inc-thermal-pump-a-b2","owner":"agent-MacBook-Pro-8.local-11228","attempt":2,"waited_ms":1121}
2026-11-08T12:57:30.801Z sim=811000 workflow settled {"workflow_id":"wf-inc-thermal-pump-a-b2","stage":"done","waited_ms":66011}
2026-11-08T12:57:30.839Z sim=811000 all workflows settled {"workflows":["wf-inc-thermal-pump-a-b2@done"],"waited_ms":1}
2026-11-08T12:57:30.853Z sim=811000 agent generation 2 stopped by harness {"pid":11228}
```
</details>

_Ledger success alone is not recovery evidence; see per-case verification and the browser witness from R4._