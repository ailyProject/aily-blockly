#!/usr/bin/env python3
"""Codex Fable5 findings ledger for review-and-repair gates."""

from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

STATE_DIR = Path(".codex-fable5")
GOALS_FILE = STATE_DIR / "goals.json"
FINDINGS_FILE = STATE_DIR / "findings.json"
LEDGER_FILE = STATE_DIR / "ledger.jsonl"

OPEN_STATUSES = {"open"}
BLOCKING_STATUSES = {"open", "blocked"}
TERMINAL_STATUSES = {"resolved", "rejected"}
SEVERITY_ORDER = {"critical": 0, "high": 1, "medium": 2, "low": 3}


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def read_json(path: Path, label: str) -> dict[str, Any]:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        sys.exit(
            f"codex-fable5: {label} is not valid JSON "
            f"({path}:{exc.lineno}:{exc.colno}: {exc.msg})."
        )


def write_json(path: Path, data: dict[str, Any]) -> None:
    STATE_DIR.mkdir(exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def append_event(event: str, **fields: Any) -> None:
    STATE_DIR.mkdir(exist_ok=True)
    record = {"ts": now(), "event": event, **fields}
    with LEDGER_FILE.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(record, ensure_ascii=False) + "\n")


def load_findings() -> dict[str, Any]:
    if not FINDINGS_FILE.exists():
        return {"created": now(), "findings": []}
    data = read_json(FINDINGS_FILE, "findings ledger")
    data.setdefault("findings", [])
    return data


def save_findings(data: dict[str, Any]) -> None:
    data["updated"] = now()
    write_json(FINDINGS_FILE, data)


def load_goals() -> dict[str, Any] | None:
    if not GOALS_FILE.exists():
        return None
    return read_json(GOALS_FILE, "goal plan")


def active_goal_id() -> str:
    goals = load_goals()
    if goals is None:
        return ""
    active = [goal for goal in goals.get("goals", []) if goal.get("status") == "in_progress"]
    if len(active) != 1:
        return ""
    return str(active[0].get("id", ""))


def next_finding_id(findings: list[dict[str, Any]]) -> str:
    max_seen = 0
    for finding in findings:
        match = re.fullmatch(r"F(\d+)", str(finding.get("id", "")))
        if match:
            max_seen = max(max_seen, int(match.group(1)))
    return f"F{max_seen + 1:03d}"


def get_finding(data: dict[str, Any], finding_id: str) -> dict[str, Any]:
    for finding in data["findings"]:
        if finding.get("id") == finding_id:
            return finding
    sys.exit(f"codex-fable5: unknown finding id {finding_id}.")


def require_text(value: str, label: str) -> str:
    text = value.strip()
    if not text:
        sys.exit(f"codex-fable5: {label} must be non-empty.")
    return text


def sort_findings(findings: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return sorted(
        findings,
        key=lambda item: (
            SEVERITY_ORDER.get(str(item.get("severity", "medium")), 99),
            str(item.get("id", "")),
        ),
    )


def format_finding(finding: dict[str, Any]) -> str:
    goal = f" goal={finding['goal']}" if finding.get("goal") else ""
    location = f" location={finding['location']}" if finding.get("location") else ""
    return (
        f"{finding['id']} [{finding['status']}] {finding['severity']} "
        f"{finding['title']}{goal}{location}"
    )


def cmd_add(args: argparse.Namespace) -> None:
    data = load_findings()
    finding_id = next_finding_id(data["findings"])
    goal = args.goal.strip() or active_goal_id()
    title = require_text(args.title, "--title")
    evidence = require_text(args.evidence, "--evidence")
    finding = {
        "id": finding_id,
        "goal": goal,
        "title": title,
        "severity": args.severity,
        "source": args.source,
        "status": "open",
        "location": args.location.strip(),
        "evidence": evidence,
        "resolution": "",
        "verify_cmd": "",
        "verify_evidence": "",
        "created": now(),
        "updated": "",
    }
    data["findings"].append(finding)
    save_findings(data)
    append_event(
        "finding_added",
        id=finding_id,
        goal=goal,
        severity=args.severity,
        source=args.source,
        title=finding["title"],
    )
    print(f"codex-fable5: added {finding_id}")
    print(format_finding(finding))


def cmd_list(args: argparse.Namespace) -> None:
    data = load_findings()
    findings = data["findings"]
    if args.status:
        findings = [finding for finding in findings if finding.get("status") == args.status]
    if args.goal:
        findings = [finding for finding in findings if finding.get("goal") == args.goal]

    if not findings:
        print("codex-fable5: no findings")
        return

    for finding in sort_findings(findings):
        print(format_finding(finding))
        if args.verbose:
            print(f"  evidence: {finding.get('evidence', '')}")
            if finding.get("resolution"):
                print(f"  resolution: {finding['resolution']}")
            if finding.get("verify_cmd"):
                print(f"  verify_cmd: {finding['verify_cmd']}")
            if finding.get("verify_evidence"):
                print(f"  verify_evidence: {finding['verify_evidence']}")


def cmd_next(args: argparse.Namespace) -> None:
    data = load_findings()
    findings = [finding for finding in data["findings"] if finding.get("status") == "open"]
    if args.goal:
        findings = [finding for finding in findings if finding.get("goal") == args.goal]
    if not findings:
        print("codex-fable5: no open findings")
        return

    finding = sort_findings(findings)[0]
    print(f"=== codex-fable5 finding: {finding['id']} {finding['title']}")
    print(f"Severity: {finding['severity']}")
    if finding.get("goal"):
        print(f"Goal: {finding['goal']}")
    if finding.get("location"):
        print(f"Location: {finding['location']}")
    print(f"Evidence: {finding['evidence']}")
    print(
        f"On resolution: codex-fable5 findings resolve --id {finding['id']} "
        '--evidence "<what changed>" --verify-evidence "<verification>"'
    )


def cmd_resolve(args: argparse.Namespace) -> None:
    data = load_findings()
    finding = get_finding(data, args.id)
    if finding["status"] not in {"open", "blocked"}:
        sys.exit(f"codex-fable5: {args.id} is {finding['status']}; reopen it first.")

    evidence = require_text(args.evidence, "--evidence")
    verify_evidence = require_text(args.verify_evidence, "--verify-evidence")
    finding["status"] = "resolved"
    finding["resolution"] = evidence
    finding["verify_cmd"] = args.verify_cmd.strip()
    finding["verify_evidence"] = verify_evidence
    finding["updated"] = now()
    save_findings(data)
    append_event(
        "finding_resolved",
        id=args.id,
        goal=finding.get("goal", ""),
        verify_cmd=finding["verify_cmd"],
        verify_evidence=finding["verify_evidence"],
    )
    print(f"codex-fable5: {args.id} -> resolved")


def cmd_reject(args: argparse.Namespace) -> None:
    data = load_findings()
    finding = get_finding(data, args.id)
    if finding["status"] in TERMINAL_STATUSES:
        sys.exit(f"codex-fable5: {args.id} is already {finding['status']}.")

    reason = require_text(args.reason, "--reason")
    finding["status"] = "rejected"
    finding["resolution"] = reason
    finding["updated"] = now()
    save_findings(data)
    append_event("finding_rejected", id=args.id, goal=finding.get("goal", ""), reason=reason)
    print(f"codex-fable5: {args.id} -> rejected")


def cmd_block(args: argparse.Namespace) -> None:
    data = load_findings()
    finding = get_finding(data, args.id)
    if finding["status"] in TERMINAL_STATUSES:
        sys.exit(f"codex-fable5: {args.id} is already {finding['status']}.")

    reason = require_text(args.reason, "--reason")
    finding["status"] = "blocked"
    finding["resolution"] = reason
    finding["updated"] = now()
    save_findings(data)
    append_event("finding_blocked", id=args.id, goal=finding.get("goal", ""), reason=reason)
    print(f"codex-fable5: {args.id} -> blocked")


def cmd_reopen(args: argparse.Namespace) -> None:
    data = load_findings()
    finding = get_finding(data, args.id)
    previous_status = finding["status"]
    finding["status"] = "open"
    finding["resolution"] = ""
    finding["verify_cmd"] = ""
    finding["verify_evidence"] = ""
    finding["updated"] = now()
    save_findings(data)
    append_event("finding_reopened", id=args.id, previous_status=previous_status)
    print(f"codex-fable5: {args.id} reopened from {previous_status}")


def cmd_gate(args: argparse.Namespace) -> None:
    data = load_findings()
    blocking_statuses = OPEN_STATUSES if args.allow_blocked else BLOCKING_STATUSES
    blockers = [
        finding
        for finding in data["findings"]
        if finding.get("status") in blocking_statuses
        and (not args.goal or finding.get("goal") == args.goal)
    ]
    blockers = sort_findings(blockers)
    if blockers:
        print(f"codex-fable5: findings gate failed; {len(blockers)} blocking findings remain")
        for finding in blockers:
            print(f"  {format_finding(finding)}")
        sys.exit(1)

    scope = f" for {args.goal}" if args.goal else ""
    print(f"codex-fable5: findings gate passed{scope}")


def cmd_status(_: argparse.Namespace) -> None:
    data = load_findings()
    counts = {
        status: sum(1 for finding in data["findings"] if finding.get("status") == status)
        for status in ["open", "blocked", "resolved", "rejected"]
    }
    summary = ", ".join(f"{count} {status}" for status, count in counts.items() if count)
    if not summary:
        summary = "0 findings"
    print(f"codex-fable5: {summary}")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="codex-fable5 findings")
    sub = parser.add_subparsers(dest="command", required=True)

    add = sub.add_parser("add")
    add.add_argument("--title", required=True)
    add.add_argument("--evidence", required=True)
    add.add_argument("--severity", choices=["low", "medium", "high", "critical"], default="medium")
    add.add_argument(
        "--source",
        choices=["main", "subagent", "test", "user", "review", "command"],
        default="main",
    )
    add.add_argument("--goal", default="")
    add.add_argument("--location", default="")

    list_cmd = sub.add_parser("list")
    list_cmd.add_argument("--status", choices=["open", "blocked", "resolved", "rejected"])
    list_cmd.add_argument("--goal", default="")
    list_cmd.add_argument("--verbose", action="store_true")

    next_cmd = sub.add_parser("next")
    next_cmd.add_argument("--goal", default="")

    resolve = sub.add_parser("resolve")
    resolve.add_argument("--id", required=True)
    resolve.add_argument("--evidence", required=True)
    resolve.add_argument("--verify-evidence", required=True)
    resolve.add_argument("--verify-cmd", dest="verify_cmd", default="")

    reject = sub.add_parser("reject")
    reject.add_argument("--id", required=True)
    reject.add_argument("--reason", required=True)

    block = sub.add_parser("block")
    block.add_argument("--id", required=True)
    block.add_argument("--reason", required=True)

    reopen = sub.add_parser("reopen")
    reopen.add_argument("--id", required=True)

    gate = sub.add_parser("gate")
    gate.add_argument("--goal", default="")
    gate.add_argument("--allow-blocked", action="store_true")

    sub.add_parser("status")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    handlers = {
        "add": cmd_add,
        "list": cmd_list,
        "next": cmd_next,
        "resolve": cmd_resolve,
        "reject": cmd_reject,
        "block": cmd_block,
        "reopen": cmd_reopen,
        "gate": cmd_gate,
        "status": cmd_status,
    }
    handlers[args.command](args)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
