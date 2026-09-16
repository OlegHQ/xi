# Ticket evidence

- Ticket ID and title:
- Outcome: passed / failed / unproven
- Implementation revision or tree hash:
- Environment and pinned dependency/oracle versions:
- Specification sections and acceptance items covered:

## Observable result

Describe the production behavior and the relevant owner contract.

## Executed validation

| Command / fixture | Actual result | Evidence path / retained CI artifact |
|---|---|---|

## Performance and visual evidence

When applicable: baseline/candidate revisions, corpus/seed, hardware/terminal, sample counts, p50/p95/p99/max, memory/CPU, screenshots and visual-review observations. Explicitly say when not applicable and why.

### Resource provenance (when applicable)

Budget IDs/catalog hash; execution classes and parent aggregate envelope; source-tree/fixture hashes; workload parameters and metric units/statistics; CPU/wall split; allocated versus retained/peak native/process/worker bytes; queued/replica bytes; baseline compatibility/noise; exact-output checks. Name unmeasured metrics explicitly. `within-target` ledger observations alone do not pass a ticket/release. For planning-only work state the limited validation scope.

## Failure cases and recovery

Record cancellation, stale/conflict, error and cleanup scenarios relevant to the ticket.

## Limitations and next action

List every unmet acceptance item. A ticket with unmet required items remains unfinished. Link minimized regressions and any follow-up tickets without treating their existence as a pass.
