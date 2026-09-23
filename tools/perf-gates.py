#!/usr/bin/env python3
"""Fast, real-PTY regression gate for source and packaged startup and file picking."""
import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
LIMITS = {
    "source-startup": {"no_file": {"p50": 175, "p95": 240},
                       "small_file": {"p50": 175, "p95": 240}},
    "package-startup": {"no_file": {"p50": 165, "p95": 260},
                        "small_file": {"p50": 165, "p95": 260}},
    "source-picker": {"prompt_ms": {"p50": 15, "p95": 50}, "result_ms": {"p50": 95, "p95": 180},
                      "cancel_ms": {"p95": 50}},
    "package-picker": {"prompt_ms": {"p50": 15, "p95": 50}, "result_ms": {"p50": 95, "p95": 180},
                       "cancel_ms": {"p95": 50}},
}
CONTRACT = {"startup": {"no_file": {"p95": 150}, "small_file": {"p95": 150}},
            "picker": {"result_ms": {"p95": 100}, "cancel_ms": {"p95": 50}}}


def failures(summary: dict, limits: dict) -> list[str]:
    return [f"{metric}.{quantile}: {summary[metric][quantile]:.1f} > {limit} ms"
            for metric, quantiles in limits.items()
            for quantile, limit in quantiles.items()
            if summary[metric][quantile] > limit]


def run(command: list[str]) -> None:
    result = subprocess.run(command, cwd=ROOT, text=True, capture_output=True)
    if result.returncode:
        raise RuntimeError(f"{' '.join(command)} failed:\n{result.stdout}{result.stderr}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--samples", type=int, default=20, help="samples per case, after warmup")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        assert failures({"result_ms": {"p95": 101}}, {"result_ms": {"p95": 100}})
        assert not failures({"result_ms": {"p95": 100}}, {"result_ms": {"p95": 100}})
        print("perf-gates threshold self-test passed")
        return
    if args.samples < 20:
        parser.error("at least 20 samples are required for a p95 gate")
    output = ROOT / ".artifacts" / "perf-gates" / datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    output.mkdir(parents=True, exist_ok=False)
    run(["bun", "run", "check:toolchain"])
    run(["bun", "run", "package:build"])
    report = {"samples_per_case": args.samples, "limits_ms": LIMITS, "contract_ms": CONTRACT,
              "scenarios": {}, "note": "Regression limits use stable medians and a tail cap; contract misses are reported separately."}
    for name, limits in LIMITS.items():
        picker = name.endswith("picker")
        script = "picker-latency-pty.py" if picker else "startup-ready-pty.py"
        command = [sys.executable, str(ROOT / "tests/support" / script),
                   "--source" if name.startswith("source") else "--binary"]
        if name.startswith("package"):
            command.append(str(ROOT / "dist/xi"))
        command += ["--samples", str(args.samples)]
        if picker:
            command += ["--settle-ms", "500"]
        attempts = []
        for attempt in (1, 2):
            path = output / f"{name}-{attempt}.json"
            run([*command, "--output", str(path)])
            data = json.loads(path.read_text())
            summary = data["summary"] if picker else data["summary_ms"]
            missed = failures(summary, limits)
            contract_missed = failures(summary, CONTRACT["picker" if picker else "startup"])
            attempts.append({"report": str(path.relative_to(ROOT)), "summary": summary,
                             "failures": missed, "contract_misses": contract_missed})
            print(f"{name} attempt {attempt}: {'PASS' if not missed else '; '.join(missed)}"
                  + (f" (contract: {'; '.join(contract_missed)})" if contract_missed else ""), flush=True)
            if not missed:
                break
        report["scenarios"][name] = attempts
    report["passed"] = all(not attempts[-1]["failures"] for attempts in report["scenarios"].values())
    path = output / "summary.json"
    path.write_text(json.dumps(report, indent=2) + "\n")
    print(f"Report: {path.relative_to(ROOT)}")
    if not report["passed"]:
        raise SystemExit("perf-gates failed; inspect both attempts and host load before changing a limit")


if __name__ == "__main__":
    main()
