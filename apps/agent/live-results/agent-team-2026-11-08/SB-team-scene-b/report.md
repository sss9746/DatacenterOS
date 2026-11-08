# R5 live recovery harness report

- **Result:** FAIL (0/1 cases)
- **Commit:** `468cda2433aa74806f2452527d1e2d805a4a4056-dirty` (Prod-Multi-Agent-System)
- **Database:** `dcos-r-local` run `run-demo-1` preset `gpu_demo_8` seed 42 speed 2; reset performed: yes
- **Model:** nvidia/nemotron-3.5-lightning-30b-a3b (live_nim)
- **Team mode:** multi
- **Started:** 2026-11-08T13:29:53.769Z on darwin MacBook-Pro-8.local v22.23.4

| Case | Result | Evidence | Sim window | Wall s | Checks |
|---|---|---|---|---|---|
| SB Scene B: all nodes down, checkpoint-backed jobs wait and restart when nodes return | FAIL | live DB + real agent process + live NIM [team mode: multi] | 601s → 945s | 172 | 20/21 |

## SB — Scene B: all nodes down, checkpoint-backed jobs wait and restart when nodes return: FAIL

**Why it failed:**
- team: specialist answer consumed by a role: 0 specialist answer(s), none reached a role's model input

**Command keys:** restart_job-a=`wf-inc-compute-node-r1-n1-b2:migrate_restart:job-a:2`, restart_job-b=`wf-inc-compute-node-r1-n1-b2:migrate_restart:job-b:2`

**Checkpoints (job-a):** complete 1 → 1
**Allocation uniqueness:** ok
**Verification:** `{"verified":false,"escalate":true,"handoff":"Partial recovery: job-c needs an operator (no completed checkpoint). Recovery verified. job-a running on 16 GPUs in rack-r1,rack-r2; progress 88368→88528 wu over 10000 sim-ms; headroom ≥14.8 C [wf-inc-compute-node-r1-n1-b2:migrate_restart:job-a:2]. job-b running on 8 GPUs in rack-r3; progress 40008→40088 wu over 10000 sim-ms; headroom ≥14.8 C [wf-inc-compute-node-r1-n1-b2:migrate_restart:job-b:2]. Next: none pending from the agent; keep monitoring.","as_of_sim_time_ms":945000,"version":1,"source":"code","outcome":"operator_review","verification_interval_sim_ms":[935000,945000],"evidence":{"incident_ids":["inc-compute-node-r1-n1-b2","inc-compute-node-r2-n1-b2","inc-compute-node-r3-n1-b2","inc-compute-node-r4-n1-b2","inc-compute-node-r5-n1-b2","inc-compute-node-r6-n1-b2","inc-compute-node-r7-n1-b2","inc-compute-node-r8-n1-b2"],"hypotheses":["inc-compute-node-r1-n1-b2: Host node-r1-n1 unreachable: 8× gpu_unavailable, 1× node_unavailable — deterministic grouping (LLM unavailable): 9 symptom(s) share degraded provider node-r1-n1 unreachable","inc-compute-node-r2-n1-b2: Host node-r2-n1 unreachable: 8× gpu_unavailable, 1× node_unavailable — deterministic grouping (LLM unavailable): 9 symptom(s) share degraded provider node-r2-n1 unreachable","inc-compute-node-r3-n1-b2: Host node-r3-n1 unreachable: 8× gpu_unavailable, 1× node_unavailable — deterministic grouping (LLM unavailable): 9 symptom(s) share degraded provider node-r3-n1 unreachable","inc-compute-node-r4-n1-b2: Host node-r4-n1 unreachable: 8× gpu_unavailable, 1× node_unavailable — deterministic grouping (LLM unavailable): 9 symptom(s) share degraded provider node-r4-n1 unreachable","inc-compute-node-r5-n1-b2: Host node-r5-n1 unreachable: 8× gpu_unavailable, 1× node_unavailable — deterministic grouping (LLM unavailable): 9 symptom(s) share degraded provider node-r5-n1 unreachable","inc-compute-node-r6-n1-b2: Host node-r6-n1 unreachable: 8× gpu_unavailable, 1× node_unavailable — deterministic grouping (LLM unavailable): 9 symptom(s) share degraded provider node-r6-n1 unreachable","inc-compute-node-r7-n1-b2: Host node-r7-n1 unreachable: 8× gpu_unavailable, 1× node_unavailable — deterministic grouping (LLM unavailable): 9 symptom(s) share degraded provider node-r7-n1 unreachable","inc-compute-node-r8-n1-b2: Host node-r8-n1 unreachable: 8× gpu_unavailable, 1× node_unavailable — deterministic grouping (LLM unavailable): 9 symptom(s) share degraded provider node-r8-n1 unreachable"],"decision_epoch":6,"max_gpu_evidence_age_sim_ms":0},"affected_jobs":[{"job_id":"job-a","status":"running","progress_work_units":88528,"durable_work_units":86400,"racks":["rack-r1","rack-r2"]},{"job_id":"job-b","status":"running","progress_work_units":40088,"durable_work_units":40000,"racks":["rack-r3"]},{"job_id":"job-c","status":"failed","progress_work_units":0,"durable_work_units":0,"racks":[]}],"actions":{"completed":["wf-inc-compute-node-r1-n1-b2:migrate_restart:job-a:2","wf-inc-compute-node-r1-n1-b2:migrate_restart:job-b:2"],"verified":["wf-inc-compute-node-r1-n1-b2:migrate_restart:job-a:2","wf-inc-compute-node-r1-n1-b2:migrate_restart:job-b:2"],"unverified":[],"blocked":[],"failed":[],"not_run":[]},"checkpoint_outcome":[],"placement_outcome":[{"job_id":"job-a","gpu_ids":["gpu-r1-n1-0","gpu-r1-n1-1","gpu-r1-n1-2","gpu-r1-n1-3","gpu-r1-n1-4","gpu-r1-n1-5","gpu-r1-n1-6","gpu-r1-n1-7","gpu-r2-n1-0","gpu-r2-n1-1","gpu-r2-n1-2","gpu-r2-n1-3","gpu-r2-n1-4","gpu-r2-n1-5","gpu-r2-n1-6","gpu-r2-n1-7"],"racks":["rack-r1","rack-r2"]},{"job_id":"job-b","gpu_ids":["gpu-r3-n1-0","gpu-r3-n1-1","gpu-r3-n1-2","gpu-r3-n1-3","gpu-r3-n1-4","gpu-r3-n1-5","gpu-r3-n1-6","gpu-r3-n1-7"],"racks":["rack-r3"]}],"unresolved_infrastructure":[],"remaining_risk":"forecast assumes the observed degradation persists and no hidden faults","next_human_action":"Partial recovery: job-c needs an operator (no completed checkpoint). none pending from the agent; keep monitoring","checks":[{"command_key":"wf-inc-compute-node-r1-n1-b2:migrate_restart:job-a:2","operation":"migrate_restart","ok":true,"note":"job-a running on 16 GPUs in rack-r1,rack-r2; progress 88368→88528 wu over 10000 sim-ms; headroom ≥14.8 C"},{"command_key":"wf-inc-compute-node-r1-n1-b2:migrate_restart:job-b:2","operation":"migrate_restart","ok":true,"note":"job-b running on 8 GPUs in rack-r3; progress 40008→40088 wu over 10000 sim-ms; headroom ≥14.8 C"}]}`
**Team:** 1 round(s) shown; Lead decided 1, fell back to deterministic code 0
**Provenance:** configured nvidia/nemotron-3.5-lightning-30b-a3b (live_nim); events nemotron=5 code=10 fallback_notices=2; log nemotron_ok=0 nemotron_failed=0 endpoint_failovers=0; team models=[nvidia/nemotron-3.5-lightning-30b-a3b] lead=1 fallback=0

```
PASS  precondition: job-a has a completed, accessible checkpoint ckpt-job-a-1, durable 86400
PASS  precondition: job-b has a completed, accessible checkpoint ckpt-job-b-1, durable 40000
PASS  precondition: job-c has no completed checkpoint  latest none, complete rows 0
PASS  all 8 node_crash faults accepted before the start tick accepted at sim 601000; outage starts at 613000
PASS  outage failed every job and took every node down sim 613000: job-a=failed job-b=failed job-c=failed
PASS  recovery waiting for the checkpoint-backed jobs  waiting=[job-a,job-b]
PASS  waiting was observed while the nodes were still down unreachable 8/8 at sim 619000
PASS  job-a work advancing after restart               progress 86416 -> 86448
PASS  job-b work advancing after restart               progress 40008 -> 40024
PASS  no migrate_restart requested during the outage   none in sim [613000, 643000)
PASS  job-a restarted from its completed checkpoint    wf-inc-compute-node-r1-n1-b2:migrate_restart:job-a:2 -> [gpu-r1-n1-0,gpu-r1-n1-1,gpu-r1-n1-2,gpu-r1-n1-3,gpu-r1-n1-4,gpu-r1-n1-5,gpu-r1-n1-6,gpu-r1-n1-7,gpu-r2-n1-0,gpu-r2-n1-1,gpu-r2-n1-2,gpu-r2-n1-3,gpu-r2-n1-4,gpu-r2-n1-5,gpu-r2-n1-6,gpu-r2-n1-7], checkpoint ckpt-job-a-1, progress 88528 >= 86400
PASS  job-b restarted from its completed checkpoint    wf-inc-compute-node-r1-n1-b2:migrate_restart:job-b:2 -> [gpu-r3-n1-0,gpu-r3-n1-1,gpu-r3-n1-2,gpu-r3-n1-3,gpu-r3-n1-4,gpu-r3-n1-5,gpu-r3-n1-6,gpu-r3-n1-7], checkpoint ckpt-job-b-1, progress 40088 >= 40000
PASS  exactly one placement per restarted job          job-a: 1 [wf-inc-compute-node-r1-n1-b2:migrate_restart:job-a:2]; job-b: 1 [wf-inc-compute-node-r1-n1-b2:migrate_restart:job-b:2]
PASS  no GPU allocated to two jobs                     24 allocation rows, all unique
PASS  job-c not restarted                              0 restart request(s) []; job failed on []
PASS  job-c handed off to an operator                  handoffs=[wf-inc-compute-node-r1-n1-b2] escalations=[]
PASS  model/fallback provenance reported               configured nvidia/nemotron-3.5-lightning-30b-a3b (live_nim); events nemotron=5 code=10 fallback_notices=2; log nemotron_ok=0 nemotron_failed=0 endpoint_failovers=0; team models=[nvidia/nemotron-3.5-lightning-30b-a3b] lead=1 fallback=0
PASS  team: Lead decided                               1/1 round(s) decided by the Lead
FAIL  team: specialist answer consumed by a role       0 specialist answer(s), none reached a role's model input
PASS  team: at most 6 model calls per round            max 4 calls across 1 round(s)
PASS  team: covers recorded with their roles           cooling covered workload
```

**Agent processes:** gen1 pid 19265 (stopped_by_harness)

<details><summary>Timeline</summary>

```
2026-11-08T13:29:54.999Z sim=- controlled reset done {"sim_time_after_ms":601000,"tick_index":1,"gpus":64,"jobs":3,"actions":0,"speed":2}
2026-11-08T13:29:55.001Z sim=601000 case start {"sim_time_ms":601000,"speed":2}
2026-11-08T13:29:55.005Z sim=601000 agent generation 1 spawned {"pid":19265,"no_llm":false,"nim_override":null,"team_mode":"multi"}
2026-11-08T13:29:55.173Z sim=601000 outage queued {"nodes":8,"start_sim_ms":613000,"duration_sim_ms":30000}
2026-11-08T13:30:04.650Z sim=619000 recovery waiting observed {"workflows":["wf-inc-compute-node-r1-n1-b2"],"jobs":["job-a","job-b"],"waited_ms":3685}
2026-11-08T13:30:15.971Z sim=643000 nodes observed back {"sim_time_ms":643000,"fault_end_sim_ms":643000,"waited_ms":11320}
2026-11-08T13:32:47.255Z sim=945000 workflow settled {"workflow_id":"wf-inc-compute-node-r1-n1-b2","stage":"escalated","waited_ms":4284}
2026-11-08T13:32:47.256Z sim=945000 all workflows settled {"workflows":["wf-inc-compute-node-r1-n1-b2@escalated"],"waited_ms":1}
2026-11-08T13:32:47.369Z sim=945000 agent generation 1 stopped by harness {"pid":19265}
```
</details>

_Ledger success alone is not recovery evidence; see per-case verification and the browser witness from R4._