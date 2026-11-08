# R5 live recovery harness report

- **Result:** PASS (1/1 cases)
- **Commit:** `cbdf9d818aed2a584061fd050b2100e61d4a368b-dirty` (Prod-Multi-Agent-System)
- **Database:** `dcos-dev` run `run-demo-1` preset `gpu_demo_8` seed 42 speed 1; reset performed: yes
- **Model:** nvidia/nemotron-3.5-lightning-30b-a3b (live_nim)
- **Team mode:** multi
- **Started:** 2026-11-08T16:12:19.743Z on darwin MacBook-Pro-8.local v22.23.4

| Case | Result | Evidence | Sim window | Wall s | Checks |
|---|---|---|---|---|---|
| L3 L1 + L2: destination Xid then SIGKILL; fresh process sees both incidents | PASS | live DB + real agent process + live NIM [team mode: multi] | 601s → 821s | 221 | 18/18 |

## L3 — L1 + L2: destination Xid then SIGKILL; fresh process sees both incidents: PASS

**Command keys:** checkpoint=`wf-inc-thermal-pump-a-b2:checkpoint:job-a:1`, planned_migrate=`wf-inc-thermal-pump-a-b2:migrate_restart:job-a:1`, failed_destination_gpu=`gpu-r1-n1-0`, final_migrate=`wf-inc-thermal-pump-a-b2:migrate_restart:job-a:2`

**Checkpoints (job-a):** complete 1 → 2
**Allocation uniqueness:** ok
**Verification:** `{"verified":true,"escalate":false,"handoff":"Recovery verified. job-a running on 16 GPUs in rack-r5,rack-r7; progress 95568→95728 wu over 10000 sim-ms; headroom ≥14.7 C [wf-inc-thermal-pump-a-b2:migrate_restart:job-a:2]. Still open: pump-a degraded (est. 9600/24000 W): needs human service; gpu-r1-n1-0 unreachable (XID 79): needs hardware service. Next: service pump-a; inspect/replace gpu-r1-n1-0.","as_of_sim_time_ms":821000,"version":1,"source":"code","outcome":"recovered","verification_interval_sim_ms":[811000,821000],"evidence":{"incident_ids":["inc-compute-gpu-r1-n1-0-b2","inc-thermal-pump-a-b2"],"hypotheses":["inc-thermal-pump-a-b2: Cooling pump-a degraded — deterministic grouping (LLM unavailable): 2 symptom(s) share degraded provider pump-a degraded","inc-compute-gpu-r1-n1-0-b2: XID 79 on gpu-r1-n1-0 — deterministic grouping (LLM unavailable): 1 symptom(s) on gpu-r1-n1-0; no degraded shared provider, treated as independent"],"decision_epoch":5,"max_gpu_evidence_age_sim_ms":0},"affected_jobs":[{"job_id":"job-a","status":"running","progress_work_units":95728,"durable_work_units":95568,"racks":["rack-r5","rack-r7"]}],"actions":{"completed":["wf-inc-thermal-pump-a-b2:migrate_restart:job-a:2"],"verified":["wf-inc-thermal-pump-a-b2:migrate_restart:job-a:2"],"unverified":[],"blocked":[],"failed":[],"not_run":[]},"checkpoint_outcome":[],"placement_outcome":[{"job_id":"job-a","gpu_ids":["gpu-r5-n1-0","gpu-r5-n1-1","gpu-r5-n1-2","gpu-r5-n1-3","gpu-r5-n1-4","gpu-r5-n1-5","gpu-r5-n1-6","gpu-r5-n1-7","gpu-r7-n1-0","gpu-r7-n1-1","gpu-r7-n1-2","gpu-r7-n1-3","gpu-r7-n1-4","gpu-r7-n1-5","gpu-r7-n1-6","gpu-r7-n1-7"],"racks":["rack-r5","rack-r7"]}],"unresolved_infrastructure":["pump-a degraded (est. 9600/24000 W): needs human service","gpu-r1-n1-0 unreachable (XID 79): needs hardware service"],"remaining_risk":"forecast assumes the observed degradation persists and no hidden faults","next_human_action":"service pump-a; inspect/replace gpu-r1-n1-0","checks":[{"command_key":"wf-inc-thermal-pump-a-b2:migrate_restart:job-a:2","operation":"migrate_restart","ok":true,"note":"job-a running on 16 GPUs in rack-r5,rack-r7; progress 95568→95728 wu over 10000 sim-ms; headroom ≥14.7 C"}]}`
**Team:** 2 round(s) shown; Lead decided 2, fell back to deterministic code 0
**Provenance:** configured nvidia/nemotron-3.5-lightning-30b-a3b (live_nim); events nemotron=16 code=9 fallback_notices=2; log nemotron_ok=0 nemotron_failed=0 endpoint_failovers=0; team models=[nvidia/nemotron-3.5-lightning-30b-a3b] lead=2 fallback=0

```
PASS  DB sim clock advances without the agent          632000 -> 634000 in 1219 ms wall, agent alive=false
PASS  checkpoint completed by the DB while the agent was dead ckpt-job-a-2 complete at sim 663000; agent alive=false
PASS  workflow reclaimed by fresh process              owner agent-MacBook-Pro-8.local-60639 -> agent-MacBook-Pro-8.local-60806, token 1 -> 3, attempt 1 -> 2
PASS  separate incident for the destination GPU fault  cooling=inc-thermal-pump-a-b2 gpu=inc-compute-gpu-r1-n1-0-b2 (2 incidents)
PASS  checkpoint completed exactly once                complete_for_key=1 writing_for_key=0 failed_for_key=0 new_complete_for_job-a=1
PASS  same accepted command keys reconciled            1 keys retained, 1 added (replan allowed)
PASS  obsolete move cancelled/superseded               wf-inc-thermal-pump-a-b2:migrate_restart:job-a:1: absent
PASS  new destination excludes failed GPU              wf-inc-thermal-pump-a-b2:migrate_restart:job-a:2 (succeeded) -> [gpu-r5-n1-0,gpu-r5-n1-1,gpu-r5-n1-2,gpu-r5-n1-3,gpu-r5-n1-4,gpu-r5-n1-5,gpu-r5-n1-6,gpu-r5-n1-7,gpu-r7-n1-0,gpu-r7-n1-1,gpu-r7-n1-2,gpu-r7-n1-3,gpu-r7-n1-4,gpu-r7-n1-5,gpu-r7-n1-6,gpu-r7-n1-7]
PASS  job-a not allocated to the failed GPU            job-a on [gpu-r5-n1-0,gpu-r5-n1-1,gpu-r5-n1-2,gpu-r5-n1-3,gpu-r5-n1-4,gpu-r5-n1-5,gpu-r5-n1-6,gpu-r5-n1-7,gpu-r7-n1-0,gpu-r7-n1-1,gpu-r7-n1-2,gpu-r7-n1-3,gpu-r7-n1-4,gpu-r7-n1-5,gpu-r7-n1-6,gpu-r7-n1-7]
PASS  no GPU allocated to two jobs                     32 allocation rows, all unique
PASS  migrate succeeded and job-a runs on its destination wf-inc-thermal-pump-a-b2:migrate_restart:job-a:2: succeeded; job-a running on [gpu-r5-n1-0,gpu-r5-n1-1,gpu-r5-n1-2,gpu-r5-n1-3,gpu-r5-n1-4,gpu-r5-n1-5,gpu-r5-n1-6,gpu-r5-n1-7,gpu-r7-n1-0,gpu-r7-n1-1,gpu-r7-n1-2,gpu-r7-n1-3,gpu-r7-n1-4,gpu-r7-n1-5,gpu-r7-n1-6,gpu-r7-n1-7]
PASS  workflow recovered or explicitly escalated       done
PASS  fresh process recorded a handoff/verification    {"verified":true,"escalate":false,"handoff":"Recovery verified. job-a running on 16 GPUs in rack-r5,rack-r7; progress 95568→95728 wu over 10000 sim-ms; headroom ≥14.7 C [wf-inc-thermal-pump-a-b2:migra
PASS  handoff/verification persisted for wf-inc-thermal-pump-a-b2 stage done: verification {"verified":true,"escalate":false,"handoff":"Recovery verified. job-a running on 16 GPUs in rack-r5,rack-r7; progress 95568→95728 wu over 10000 sim-ms; headroom
PASS  team: Lead decided                               2/2 round(s) decided by the Lead
PASS  team: specialist answer consumed by a role       wf-inc-thermal-pump-a-b2:a1:e1:m7 workload -> [cooling,lead]; wf-inc-thermal-pump-a-b2:a2:e3:m5 workload -> [cooling,lead]; wf-inc-thermal-pump-a-b2:a2:e3:m6 cooling -> [lead]
PASS  team: at most 6 model calls per round            max 5 calls across 2 round(s)
PASS  team: covers recorded with their roles           no cover occurred
```

**Agent processes:** gen1 pid 60639 (SIGKILL); gen2 pid 60806 (stopped_by_harness)

<details><summary>Timeline</summary>

```
2026-11-08T16:12:21.381Z sim=- controlled reset done {"sim_time_after_ms":601000,"tick_index":1,"gpus":64,"jobs":3,"actions":0,"speed":1}
2026-11-08T16:12:21.382Z sim=601000 case start {"sim_time_ms":601000,"speed":1}
2026-11-08T16:12:21.386Z sim=601000 agent generation 1 spawned {"pid":60639,"no_llm":false,"nim_override":null,"team_mode":"multi"}
2026-11-08T16:12:21.429Z sim=601000 injected pump-a degradation 0.6 {"fault_id":"l3-pump-601000","start_sim_time_ms":602000}
2026-11-08T16:12:53.113Z sim=632000 checkpoint running {"command_key":"wf-inc-thermal-pump-a-b2:checkpoint:job-a:1","due_sim_time_ms":null,"waited_ms":31684}
2026-11-08T16:12:53.115Z sim=632000 planned destination observed {"command_key":"wf-inc-thermal-pump-a-b2:migrate_restart:job-a:1","source":"workflow_state","status":"planned","gpu_ids":["gpu-r1-n1-0","gpu-r1-n1-1","gpu-r1-n1-2","gpu-r1-n1-3","gpu-r1-n1-4","gpu-r1-n1-5","gpu-r1-n1-6","gpu-r1-n1-7","gpu-r5-n1-0","gpu-r5-n1-1","gpu-r5-n1-2","gpu-r5-n1-3","gpu-r5-n1-4","gpu-r5-n1-5","gpu-r5-n1-6","gpu-r5-n1-7"]}
2026-11-08T16:12:53.163Z sim=632000 injected gpu_xid_79 on gpu-r1-n1-0 {"fault_id":"l3-xid79-gpu-r1-n1-0-633000","start_sim_time_ms":633000}
2026-11-08T16:12:53.178Z sim=632000 agent generation 1 killed {"pid":60639,"how":"SIGKILL","waited_ms":15,"sim_at_kill":632000}
2026-11-08T16:13:23.418Z sim=663000 agent generation 2 spawned {"pid":60806,"no_llm":false,"nim_override":null,"team_mode":"multi"}
2026-11-08T16:13:25.212Z sim=664000 workflow reclaimed {"workflow_id":"wf-inc-thermal-pump-a-b2","owner":"agent-MacBook-Pro-8.local-60806","attempt":2,"waited_ms":1794}
2026-11-08T16:16:01.912Z sim=821000 workflow settled {"workflow_id":"wf-inc-thermal-pump-a-b2","stage":"done","waited_ms":156699}
2026-11-08T16:16:01.918Z sim=821000 all workflows settled {"workflows":["wf-inc-thermal-pump-a-b2@done"],"waited_ms":0}
2026-11-08T16:16:01.936Z sim=821000 agent generation 2 stopped by harness {"pid":60806}
```
</details>

_Ledger success alone is not recovery evidence; see per-case verification and the browser witness from R4._