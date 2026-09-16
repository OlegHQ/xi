# Completion audit — 2026-09-15

## Outcome

46 formerly completed tickets are reopened as `todo`: 24 have identified acceptance/evidence gaps and 22 lose completion because required prerequisites are reopened. The resulting backlog is 56 done, 1 in progress (T106), and 64 todo. This is an accounting correction, not deletion of implemented components or a measurement of percent product readiness.

The user reports poor Vim behavior, missing mouse and arrow support, poor UX and questionable latency in `bun run xi`. Source inspection confirms missing application integration. Arrow behavior and perceived latency are user-reported regressions requiring actual-terminal reproductions; this audit does not invent test results or diagnose every key.

Scope: backlog/evidence/documentation only. Another agent is implementing concurrently. No runtime code, fixtures, thresholds, dependency edges, agentpack files or personal configuration were changed. T106 stays in progress. Work against the current files and avoid overwriting the concurrent agent's changes.

## Evidence supporting the correction

- `apps/xi/src/main.ts` directly builds one document/view and handles a subset of Vim intents. It does not instantiate WorkbenchSession or LSP services.
- `packages/ui/src/terminal.ts:runOpenTuiWorkbench` constructs a basic WorkbenchRenderable and registers keypress handling; it does not compose the owned pointer/workbench gesture path.
- `tests/e2e/t045-g3.test.ts` checks exported constructors/functions. These assertions do not drive required G3 keyboard, mouse, focus and recovery journeys.
- `tests/e2e/t056-g4.test.ts` checks exported constructors and snippet expansion. It does not launch Xi with TS/Go/Rust servers or run E07/E08/E14.
- T038's report explicitly describes a WorkbenchSession script under a PTY and defers actual picker/CLI routing. A PTY around a component script does not certify the application journey.
- T050/T051 explicitly defer transport/PTY integration; T057–T060 describe narrower parser/coordinator/state/fake-process fixtures than their acceptance requires.
- Spec 14 documents that a timer around a full parse is not proof of bounded main-thread stalls; T053's completion claim cannot certify its typing acceptance.

## Directly reopened acceptance

| Ticket | Concrete missing acceptance/evidence |
|---|---|
| T038 | E02/E11 evidence drives WorkbenchSession from a script inside a PTY; the actual launcher does not instantiate that session or expose split/preview journeys. |
| T039 | Picker models and an isolated renderer exist, but the launcher's file/buffer/command picker and preview/cancel journey are not wired. The recorded 100k-path microbenchmark remains historical component evidence. |
| T040 | Explorer models and an isolated renderer exist; E03 external-change/focus behavior is not demonstrated through the launched Explorer panel. |
| T043 | The report records injected backend/component fixtures, with no measured warm first-result/cancellation budget for the production workspace-search journey. |
| T045 | G3 composition checks do not establish the required actual workbench journeys, complete screenshot review and navigation/search under typing load. |
| T049 | Diagnostic store/Problems component tests do not establish E07 in the CLI or 10k diagnostics while typing through the production editor. |
| T050 | The report explicitly defers actual LSP dispatch and E07 PTY wiring; definition/hover return values are not the required navigation-and-focus journey. |
| T051 | The report explicitly defers request/resolve transport wiring; completion/signature UI and keyboard acceptance are not connected to the launcher. |
| T052 | Workspace-edit preflight tests do not establish E08 dirty/open/closed multi-file actions and rename through the editor, including command feedback. |
| T053 | Scheduling a full parse on a timer does not establish that typing cannot wait for that parse. Spec 14 records the missing oversized-parse/resync input test and T112 remediation. |
| T055 | Injected formatter stability/version tests do not establish pinned real-tool formatting and E08 concurrent typing through the launcher's save pipeline. |
| T056 | The G4 test mostly checks exported constructors and a snippet. Required actual CLI E07/E08/E14, real TS/Go/Rust servers and version/hash records are not established. |
| T057 | The report qualifies porcelain parsing/cache only and defers diff rendering; actual temporary-repository comparison and E11 diff-selection UX remain unproven. |
| T058 | Executor/argv fixtures do not establish actual index bytes, selected-hunk staging and E09 commit/draft behavior. |
| T059 | The report explicitly defers real-repository merge orchestration and diff hunk UI; E10 final file/unmerged-state and history focus journeys remain unproven. |
| T060 | The report says no real child process is started by its fixture and defers problem matchers/E17. Reaping and loaded typing budgets remain unproven. |
| T065 | G5 cannot qualify the required Git/task/integrity journeys from component fixtures while their required production journeys remain incomplete. |
| T081 | Selection command algorithms exist, but keyboard selection creation/manipulation is not connected to the actual launcher; the first-class keyboard acceptance remains incomplete. |
| T082 | Prefix-help model/timer/renderer fixtures do not establish E20 visible help driven by the actual editor parser and focus lifecycle. |
| T083 | Native write/quit support in the launcher does not supply the required E20 Ex suggestions, visible Tab acceptance and registered alias/discovery journey. |
| T086 | Gesture/capture components are not connected to the launcher's terminal input and document/view state. Required actual editor PTY E21/E22 gestures remain incomplete. |
| T088 | Language-edit/snippet composition fixtures do not establish actual editor MC11/E24 requests, multiple cursors and synchronized snippet Tab acceptance. |
| T094 | Workbench mouse control/capture helpers do not provide controls in the running editor. Actual E21/E22 and the required terminal restoration matrix remain unproven. |
| T095 | Persisted selection models do not establish MC10/E19 split/session/recovery restoration through the launcher, which does not use WorkbenchSession. |

## Dependency invalidation

- T033: Completion is withdrawn because prerequisite acceptance was reopened: T092. Existing component evidence is retained; this is not a newly observed defect in this ticket's implementation.
- T034: Completion is withdrawn because prerequisite acceptance was reopened: T033. Existing component evidence is retained; this is not a newly observed defect in this ticket's implementation.
- T035: Completion is withdrawn because prerequisite acceptance was reopened: T034. Existing component evidence is retained; this is not a newly observed defect in this ticket's implementation.
- T036: Completion is withdrawn because prerequisite acceptance was reopened: T035. Existing component evidence is retained; this is not a newly observed defect in this ticket's implementation.
- T037: Completion is withdrawn because prerequisite acceptance was reopened: T035. Existing component evidence is retained; this is not a newly observed defect in this ticket's implementation.
- T041: Completion is withdrawn because prerequisite acceptance was reopened: T040. Existing component evidence is retained; this is not a newly observed defect in this ticket's implementation.
- T042: Completion is withdrawn because prerequisite acceptance was reopened: T041. Existing component evidence is retained; this is not a newly observed defect in this ticket's implementation.
- T044: Completion is withdrawn because prerequisite acceptance was reopened: T043, T042. Existing component evidence is retained; this is not a newly observed defect in this ticket's implementation.
- T047: Completion is withdrawn because prerequisite acceptance was reopened: T036. Existing component evidence is retained; this is not a newly observed defect in this ticket's implementation.
- T048: Completion is withdrawn because prerequisite acceptance was reopened: T047. Existing component evidence is retained; this is not a newly observed defect in this ticket's implementation.
- T054: Completion is withdrawn because prerequisite acceptance was reopened: T053. Existing component evidence is retained; this is not a newly observed defect in this ticket's implementation.
- T067: Completion is withdrawn because prerequisite acceptance was reopened: T054. Existing component evidence is retained; this is not a newly observed defect in this ticket's implementation.
- T068: Completion is withdrawn because prerequisite acceptance was reopened: T049. Existing component evidence is retained; this is not a newly observed defect in this ticket's implementation.
- T069: Completion is withdrawn because prerequisite acceptance was reopened: T051. Existing component evidence is retained; this is not a newly observed defect in this ticket's implementation.
- T070: Completion is withdrawn because prerequisite acceptance was reopened: T050. Existing component evidence is retained; this is not a newly observed defect in this ticket's implementation.
- T071: Completion is withdrawn because prerequisite acceptance was reopened: T038, T040. Existing component evidence is retained; this is not a newly observed defect in this ticket's implementation.
- T072: Completion is withdrawn because prerequisite acceptance was reopened: T058. Existing component evidence is retained; this is not a newly observed defect in this ticket's implementation.
- T073: Completion is withdrawn because prerequisite acceptance was reopened: T042, T044, T057. Existing component evidence is retained; this is not a newly observed defect in this ticket's implementation.
- T087: Completion is withdrawn because prerequisite acceptance was reopened: T034. Existing component evidence is retained; this is not a newly observed defect in this ticket's implementation.
- T090: Completion is withdrawn because prerequisite acceptance was reopened: T035. Existing component evidence is retained; this is not a newly observed defect in this ticket's implementation.
- T091: Completion is withdrawn because prerequisite acceptance was reopened: T039, T082, T083, T095. Existing component evidence is retained; this is not a newly observed defect in this ticket's implementation.
- T092: Completion is withdrawn because prerequisite acceptance was reopened: T081. Existing component evidence is retained; this is not a newly observed defect in this ticket's implementation.

These dependency reopenings do not assert that all of their own component tests fail. They enforce the existing rule that a completed ticket must have completed prerequisites. In particular, G2's completed multi-cursor dependency cannot remain done while keyboard selection creation is unfinished. Existing successful fixture results remain useful historical evidence.

Each affected report now begins with the current unproven status. Its original results and source manifests are preserved as historical records; old “passed” or “no acceptance remains” text is superseded by that notice. Tickets left done were not exhaustively recertified by this audit.

## Concrete continuation and regression requirements

1. Run `python3 tools/plan.py check` and `next` from the current tree. At audit time T081 is ready; T106 remains independently in progress. The active performance agent can continue T106 without a status reset.
2. T081: drive selection creation/manipulation using actual CLI keyboard input and assert resulting selections/text; package-level command calls alone do not complete keyboard UX.
3. T035/T116: reproduce Up/Down/Left/Right in Normal and Insert through the actual terminal decoder and editor dispatch, including held/repeated input, Unicode, line edges, mode changes and exact saved text. Audit all declared Vim intent routes, including repeat, macros, registers, search, Visual and undo/redo; track missing behavior against its existing owner and T061. Do not weaken engine parity to match the launcher.
4. T086/T094: actual CLI press/drag/release/wheel, click-to-position, selection and splitter/control journeys with keyboard equivalents, correct state and cleanup. A helper invoked directly from a PTY script is insufficient.
5. T045/T056/T065: replace superficial qualification with the already-required application journeys. Record real server/tool versions, exact fixture results, terminal screenshots reviewed and failure paths.
6. Existing acceptance remains intact. If integration ownership requires a ticket split, name each behavior, preserve all checks and edges, and expose concrete production paths; do not hide the work behind a generic final integration ticket.

## Performance requirement

The user's priority is immediate, responsive editing on every keystroke, including while language/search/Git work runs. Performance is a release requirement, not deferred polish. Zero physical latency is not a measurable promise an application can satisfy; the existing strict engineering budgets remain mandatory and unproven:

- Ordinary engine step: p95 ≤ 1 ms; p99 ≤ 2 ms.
- Input to correct terminal-output completion: p95 ≤ 8 ms; p99 ≤ 16 ms.
- Loaded typing with LSP/search/Git: p95 ≤ 12 ms; p99 ≤ 25 ms.
- Record p50/p95/p99/max, at least 10,000 interactive samples across sessions, GC/allocation, background stalls and real baseline comparisons. Percentile passes do not excuse unexplained stalls.
- Measure real terminal visible response separately from PTY output; process completion is not display latency. Include long lines, large files, cold caches, repeated keys, multiple selections and background load under the existing workload catalog.

T106/T107–T118/T062 retain all existing workload, CPU, memory, host, latency and regression obligations. No new benchmark pass is claimed here.

## Validation and provenance

- Base Git revision: `555ed0ce3c2475a10844824468e6fddbb6e49755`; substantial shared uncommitted tree.
- Executed read-only checks: ticket contracts via jq; source and evidence inspection via sed/rg; `git status --short`; `git rev-parse HEAD`.
- `python3 tools/plan.py check`: passed after the 46 status corrections; graph and report references valid, not product acceptance.
- `python3 tools/plan.py next`: T081 ready after corrections.
- Final rerun: plan check passed, T081 remained ready, counts were 56 done / 1 in progress / 64 todo, and `git diff --check` passed.
- No product tests, live server tests, visual approval or latency measurements were executed in this documentation audit. Required product gates remain unproven.
