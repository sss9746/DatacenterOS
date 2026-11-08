# DataCenterOS dashboard
<!-- impeccable:product-schema 1 -->

## Platform
web

## Stack
React, Vite, TypeScript, Tailwind and shadcn/ui; Vercel deployment per the team's P4 lane plan.

## Users
GPU facility operators tracking training work during failures. HackUTD judges follow a three-minute demonstration on the presenter's laptop.

## Product Purpose
Show which jobs are at risk, how separate incidents affect them, what the agent proposes, and which durable actions execute or are blocked.

## Operating Context
An eight-rack, 64-GPU digital twin with three jobs. Pump A serves racks r2–r4. Job A has an older checkpoint than job B. A second XID fault must remain a separate incident. Simulated time starts at 600000 ms and differs from wall time.

## Capabilities and Constraints
All shared types come from @dcos/contracts and @dcos/db-client. The default local mode runs the same pure @dcos/physics engine used by P1, in this browser only; it does not implement a second physics model or persist a durable workflow. Fixture views use P2's mock client. Live mode requires P2's connect implementation. The agent-facing projection and plan comparison use ObservedSnapshot, with no private fault truth or raw chain-of-thought. Public builds have no admin credentials. Real GPU readings and simulated values stay distinct. Benchmark numbers must come from actual evaluations; missing metrics remain unavailable.

## Brand Commitments
Team brief: dark operator console, one accent for agent actions. Plain, factual language. The comparison policy is a “reactive rule-based baseline.”

## Evidence on Hand
PLAN.md; plans/LANE-P4-web.md; plans/CONTRACTS.md §0; plans/ARCHITECTURE.md §9, §11; P2 mock and P1 fixtures from lane/p2-db b71ad91. No evaluated benchmark results, hardware readings, or verified deployment are supplied.

## Product Principles
Make training work and checkpoint durability legible. Preserve separate incidents. Show why actions were blocked. Disclose provenance and unavailable data. Keep controls familiar and accessible.

## Open Dependencies
Live DB tables/client; action metadata (operation/target); real policy runner; unfinished-job and cache provenance fields; Vercel authentication and event registration verification.
