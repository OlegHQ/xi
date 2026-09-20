# Status-message expiry

- Outcome: status notices no longer permanently replace the normal status row.
- Reference: inspected the supplied recovery-checkpoint screenshot downloaded with `curl`.

Informational notices, including recovery and disk-divergence notices, expire after 5 seconds.
Errors expire after 8 seconds. Publishing a replacement cancels the previous timer, and
shutdown disposes the active timer. Timing is owned by the shared workbench status controller
through the injected platform clock; individual callers do not create timers.

## Checks

- `bun test tests/workbench/status-message.test.ts`: passed expiry, replacement race and
  disposal cases with a deterministic fake clock.
- `bun run check`: passed strict types, public boundary, architecture and lint.
- `bun run test:unit`: passed all 96 unit fixtures.

The durations are fixed UX policy rather than new configuration surface.
