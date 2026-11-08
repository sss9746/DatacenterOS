# Research notes (Sat Nov 7, 2026)

These are four research passes run before locking the niche. Every fact has a source link. Items marked **unverified** came from search snippets or vendor blogs. **Verify them before putting them on a slide.**

> **Proposed niche (pending team lock):** a **pre-flight check for hands-on work at a GPU facility**. Before a technician opens a breaker, shuts a pump or pulls a server, DataCenterOS checks the records (CMDB, tickets, handoffs) against live telemetry, simulates the change across power and cooling, and stops it if the records are wrong.
> **Pitch line:** "62% of major IT outages start with a change. We check the records against reality before the change runs."

---

## 1. Industry statistics (Uptime Institute)
- **2026 report** (May 13, 2026):
  - 57% said their last major outage cost over $100k, and 1 in 5 cost over $1M.
  - On-site power generation and distribution is the top cause of serious outages.
  - Not following procedures is the leading driver of human-error outages.
  - https://www.businesswire.com/news/home/20260513289344/en/Uptime-Announces-Annual-Outage-Analysis-Report-2026
- **2025 report** (May 2025):
  - Power caused 54% of impactful outages, and cooling about 19%.
  - Human error played a role in about 2/3 to 4/5 of outages.
  - About 40% of organisations had a major outage from human error in 3 years. 85% of those came from staff not following procedures, or from flawed procedures.
  - 80% said better management would have prevented their outage.
  - https://www.businesswire.com/news/home/20250506733553/en/Uptime-Announces-Annual-Outage-Analysis-Report-2025
  - https://www.datacenterknowledge.com/outages/data-center-outages-decline-for-fourth-straight-year-but-issues-persist
- **Change failures** (Uptime 2025):
  - Configuration or change-management failure caused **50% of major network outages** and **62% of major IT/software outages**.
  - Among human-error cases, staff not following procedures was a factor in 58%, and faulty procedures in 45%.
  - https://www.networkworld.com/article/3980366/
  - https://www.theregister.com/2025/05/07/human_error_a_factor_in
- **Cost** (Uptime 2024): 54% said their last significant outage cost over $100k, and 16% said over $1M. https://intelligence.uptimeinstitute.com/resource/annual-outage-analysis-2024
- **Alarm fatigue** (vendor blog, so weaker evidence): facility managers average more than 12 alarms a day, and half get more than 30. ISA-18.2 defines an alarm flood as more than 10 alarms per operator in 10 minutes. https://www.cim.io/blog/bms-alarm-fatigue

## 2. Real incidents
| Incident | What happened | DataCenterOS fit |
|---|---|---|
| **Equinix SG, Singapore** (Oct 2023) | During a planned upgrade, a contractor wrongly signalled the chilled-water valves to close. DBS and Citi had about 2 days of disruption and 2.5M failed transactions, and the regulator (MAS) imposed penalties. https://datacenterdynamics.com/en/news/equinix-blames-singapore-outage-on-third-party-contractor · https://www.theregister.com/2023/11/07/overheating_datacenter_singapore | **Strongest.** A pre-flight check on the clone blocks the step |
| **South Dakota state data center** (Aug 2025) | Wires were mislabeled after 50 years of changes. Electricians believed circuits were dead when they were live. 2-day statewide outage and about $80k of damaged gear. https://statescoop.com/south-dakota-wiring-issues-two-day-outage/ | Record vs live reading at the moment of action |
| **CME Group / CyrusOne, Chicago** (Nov 2025) | A chiller plant failure pushed halls above 100°F. The operator warned clients about 12 h before trading halted for more than 10 h. https://www.insurancejournal.com/news/midwest/2025/12/01/849319.htm · https://news.bgov.com/capital-markets/cme-data-center-woes-started-12-hours-before-the-market-opened | Early warning, plus checking that the fix worked |
| **Azure Australia East** (Aug 2023) | A lightning power sag tripped 13 chillers that needed a manual restart. 3 night staff on site; about 46 h outage. https://www.itnews.com.au/news/microsoft-had-three-staff-at-australian-data-centre-campus-when-azure-went-out-599849 | Utility loss, then agent-sequenced recovery (Tier 2) |
| **British Airways** (May 2017) | A contractor shut off the UPS, and power came back uncontrolled. About £80M lost. https://www.datacenterknowledge.com/archives/2017/06/06/british-airways-says-engineer-disconnected-data-center-power-supply | Block the unsafe operator action |
| **RAL Tier1** (Dec 2011) | A reused server still showed as "decommissioned" in the database, so it was shut down and its disks wiped. 3-day outage. https://archive.gridpp.ac.uk/wiki/RAL_Tier1_Incident_20111202_VO_Software_Server (**unverified**: the page returned 401) | Record drift |
| **Google + Oracle, London** (Jul 2022) | Redundant cooling failed together in 40°C heat. https://www.datacenterdynamics.com/en/news/googles-london-data-center-outage-during-heatwave-caused-by-simultaneous-failure-of-multiple-redundant-cooling-systems | Redundancy check |
| **Google europe-west9, Paris** (Apr 2023) | A cooling leak reached the UPS room and started a fire. https://www.theregister.com/2023/04/26/google_cloud_outage/ | Partial; leaks aren't modeled |
| **Delta, Atlanta** (Aug 2016) | A switchgear fire, and not all servers had backup power. About $100M lost. https://www.datacenterknowledge.com/outages/delta-data-center-outage-grounds-hundreds-of-flights | Auditing the power topology |
| **OVHcloud SBG2** (Mar 2021) | A UPS fire after same-day servicing. https://www.theregister.com/2022/03/22/ovhcloud_fire_datacenter_report/ | **Wouldn't help.** It's a building-design issue |

## 3. CMDB / DCIM record accuracy
- **Gartner:** "Through 2024, 99% of organizations using CMDB tooling that do not confront CI data quality gaps will experience visible business disruptions" (Dec 2020). **Partly verified** (seen only in search snippets). https://www.ivanti.com/en-gb/lp/cloud/assets/s1/gartner-report-3-steps-to-improve-it-service-view-cmdb-data-quality
- **Vendor-sourced claims (unverified):** about 60% average CMDB accuracy, 30–50% drift from discovery scans, and 75% of CMDB initiatives failing. https://virima.com/blog/the-real-cost-of-cmdb-inaccuracy-a-tco-analysis
- **ServiceNow Discovery:** rack units and allocated power have to be maintained by hand, and devices that aren't on the network can't be discovered. https://www.servicenow.com/community/cmdb-articles/managing-space-and-power-of-server-it-racks/ta-p/2300919
- **The gap in existing tools:**
  - Nlyte PowerView and Sunbird dcTrack simulate changes against the **recorded** model only. https://www.nlyte.com/web/wp-content/uploads/2019/09/PowerView™_Data_Sheet.pdf · https://www.sunbirddcim.com/sites/default/files/DS009_Sunbird_DataSheet_dcTrack8_0.pdf
  - NetBox holds static records with no live telemetry. https://netboxlabs.com/docs/netbox/en/stable/features/power-tracking/
  - Device42 only discovers what's on the network.
  - **None of them checks the record against reality at the moment someone acts.** That last point is an inference, not confirmed.
- **Atlassian** (Apr 2022): a script was run with the wrong type of ID, deleting 883 sites, and review never checked what the IDs referred to. https://www.atlassian.com/engineering/post-incident-review-april-2022-outage

## 4. NMC² (NorthMark Compute & Cloud)
- A Dallas company. It is building a **$2.8B, 400 MW NVIDIA GPU facility** in Spartanburg, SC (in a former Kohler plant), with on-site gas turbines and about 150 jobs. First operations were due Q3 2026, with construction through 2028.
  - https://nmc2.com
  - https://scdailygazette.com/2025/04/22/cutting-edge-supercomputing-facility-a-2-8b-investment-planned-for-spartanburg-county/
  - https://www.wspa.com/news/local-news/company-provides-update-on-data-center-under-construction-in-spartanburg/amp/
- **Hiring:**
  - Electrical Ops SMEs on rotating 24/7 shifts (UPS, generators, switchgear, LOTO, NFPA 70E, root-cause analysis). https://builtin.com/job/electrical-operations-sme-2/9738412
  - Mechanical SMEs for chilled-water and liquid cooling. https://www.tealhq.com/job/mechanical-operations-sme_7ea1a91b16a47300279044e005fb818c75978
  - Controls SMEs.
  - A bare-metal Kubernetes team (Slurm/Volcano). https://builtin.com/job/senior-kubernetes-engineer/9738410
- **HackUTD 2025 brief:** HPC work-order intelligence, dispatch routing and technician automation. Known winner DcDaddy (3rd): technician routing, ticket bundling, cabling views. https://github.com/anishalle/hackutd2025
- **Ranked niche fit for these judges:**
  1. Technician error prevention + shift handoff
  2. Physical power and cooling ops
  3. CMDB, as the data layer
  4. GPU / Kubernetes (weakest fit)

## 5. GPU / Kubernetes (considered, not chosen)
- **Meta, Llama 3 405B:** 419 interruptions in 54 days on 16,384 H100s, 58.7% of them GPU-related. https://arxiv.org/pdf/2407.21783
- **Meta research clusters:** 1,024-GPU jobs fail about every 7.9 h. https://arxiv.org/pdf/2410.21680
- **Alibaba C4:** over 30% of training time lost to downtime, mostly manual diagnosis. https://arxiv.org/html/2406.04594v1
- **Cast AI:** 5% average GPU utilization across Kubernetes clusters (Apr 2026). https://cast.ai/press-release/2026-state-of-kubernetes-optimization-report/
- **Already solved by existing tools:**
  - NVIDIA **NVSentinel** (open source, Dec 2025): detects faults, takes the node out of service and drains it. https://developer.nvidia.com/blog/automate-kubernetes-ai-cluster-health-with-nvsentinel/
  - **Komodor:** AI root-cause analysis for GPU failures.
- **Why it wasn't chosen:** the space is crowded, and it's the weakest fit for NMC²'s "data center team" brief. It could be simulated with NVIDIA's Fake GPU Operator plus KWOK. https://docs.nvidia.com/nvcf/fake-gpu-operator

## 6. How ops teams work today
- **MOPs** (written step-by-step procedures) have each step initialed and timestamped, with a back-out plan. https://journal.uptimeinstitute.com/the-making-of-a-good-method-of-procedure/
- **Shift turnover:** without a formal handover, the incoming shift has to rediscover system state by hand. https://www.infotech.com/research/data-center-shift-turnover-checklist
- **Staffing:** long shifts and thin staffing raise risk (Azure Sydney). https://www.itpro.com/infrastructure/data-centres/data-center-staff-are-getting-burnt-out-and-this-could-be-causing-more-frequent-outages

## 7. Pitch lines with sources
- "62% of major IT outages come from configuration or change failures." (Uptime 2025)
- "One contractor's wrong valve signal stopped 2.5M Singapore bank transactions." (DCD 2023)
- "Electricians in South Dakota thought a circuit was dead because the labels said so. It was live." (StateScoop 2025)
- "85% of human-error outages come from not following procedures, or bad procedures." (Uptime 2025)
