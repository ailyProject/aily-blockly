#!/usr/bin/env python3
"""Codex Fable5 goal ledger with evidence checkpoints and a final verification gate."""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

STATE_DIR = Path(".codex-fable5")
GOALS_FILE = STATE_DIR / "goals.json"
FINDINGS_FILE = STATE_DIR / "findings.json"
LEDGER_FILE = STATE_DIR / "ledger.jsonl"
OPEN_STATUSES = {"pending", "in_progress"}
INCOMPLETE_TERMINAL_STATUSES = {"failed", "blocked"}
BLOCKING_FINDING_STATUSES = {"open", "blocked"}


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def safe_stamp() -> str:
    return now().replace(":", "").replace("+", "Z")


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


def load_plan() -> dict[str, Any]:
    if not GOALS_FILE.exists():
        sys.exit("codex-fable5: no goal plan. Run `create` from the repo root first.")
    return read_json(GOALS_FILE, "goal plan")


def parse_goal(raw: str, index: int) -> dict[str, Any]:
    if "::" not in raw:
        sys.exit(f"codex-fable5: goal {index} must use 'title::objective' format.")
    title, objective = raw.split("::", 1)
    title = title.strip()
    objective = objective.strip()
    if not title or not objective:
        sys.exit(f"codex-fable5: goal {index} needs both title and objective.")
    return {
        "id": f"G{index:03d}",
        "title": title,
        "objective": objective,
        "status": "pending",
        "evidence": "",
        "verify_cmd": "",
        "verify_evidence": "",
    }


def incomplete_terminal_summary(goals: list[dict[str, Any]]) -> str:
    counts = {
        status: sum(1 for goal in goals if goal["status"] == status)
        for status in sorted(INCOMPLETE_TERMINAL_STATUSES)
    }
    return ", ".join(f"{count} {status}" for status, count in counts.items() if count)


def terminal_incomplete_goals(goals: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [goal for goal in goals if goal["status"] in INCOMPLETE_TERMINAL_STATUSES]


def archive_findings_for_force() -> None:
    if not FINDINGS_FILE.exists():
        return
    archive_path = STATE_DIR / f"findings.{safe_stamp()}.archive.json"
    FINDINGS_FILE.replace(archive_path)
    append_event(
        "findings_archived",
        reason="goals_create_force",
        path=str(archive_path),
    )


def blocking_findings() -> list[dict[str, Any]]:
    if not FINDINGS_FILE.exists():
        return []
    data = read_json(FINDINGS_FILE, "findings ledger")
    return [
        finding
        for finding in data.get("findings", [])
        if finding.get("status") in BLOCKING_FINDING_STATUSES
    ]


def cmd_create(args: argparse.Namespace) -> None:
    if GOALS_FILE.exists() and not args.force:
        sys.exit("codex-fable5: plan already exists. Use `status` or replace it with --force.")
    goals = [parse_goal(raw, index) for index, raw in enumerate(args.goal, 1)]
    if not goals:
        sys.exit("codex-fable5: at least one --goal is required.")
    if args.force:
        archive_findings_for_force()
    plan = {"brief": args.brief, "created": now(), "goals": goals}
    write_json(GOALS_FILE, plan)
    append_event("plan_created", brief=args.brief, count=len(goals))
    print(f"codex-fable5: plan created with {len(goals)} stories")
    for goal in goals:
        print(f"  {goal['id']} {goal['title']}: {goal['objective']}")


def cmd_next(_: argparse.Namespace) -> None:
    plan = load_plan()
    active = [goal for goal in plan["goals"] if goal["status"] == "in_progress"]
    if active:
        goal = active[0]
    else:
        incomplete = terminal_incomplete_goals(plan["goals"])
        if incomplete:
            goal = incomplete[0]
            previous_status = goal["status"]
            goal["status"] = "in_progress"
            write_json(GOALS_FILE, plan)
            append_event(
                "story_reopened",
                id=goal["id"],
                title=goal["title"],
                previous_status=previous_status,
            )
            print(f"Reopened {goal['id']} from {previous_status}.")
        else:
            pending = [goal for goal in plan["goals"] if goal["status"] == "pending"]
            if not pending:
                print("codex-fable5: all stories complete")
                return
            goal = pending[0]
            goal["status"] = "in_progress"
            write_json(GOALS_FILE, plan)
            append_event("story_started", id=goal["id"], title=goal["title"])

    is_final = goal["id"] == plan["goals"][-1]["id"]
    print(f"=== codex-fable5 handoff: {goal['id']} {goal['title']}")
    print(f"Objective: {goal['objective']}")
    print("Rule: work this story only and produce concrete evidence.")
    command = (
        f"codex-fable5 goals checkpoint --id {goal['id']} --status complete "
        '--evidence "<evidence>"'
    )
    if is_final:
        print("Final story: completion requires --verify-cmd and --verify-evidence.")
        command += ' --verify-cmd "<command>" --verify-evidence "<result>"'
    print(f"On completion: {command}")


def cmd_checkpoint(args: argparse.Namespace) -> None:
    plan = load_plan()
    goal = next((item for item in plan["goals"] if item["id"] == args.id), None)
    if goal is None:
        sys.exit(f"codex-fable5: unknown goal id {args.id}.")
    if goal["status"] != "in_progress":
        sys.exit(f"codex-fable5: {args.id} is {goal['status']}; activate it with `next` first.")

    evidence = args.evidence.strip()
    verify_cmd = args.verify_cmd.strip()
    verify_evidence = args.verify_evidence.strip()
    if args.status == "complete":
        if not evidence:
            sys.exit("codex-fable5: complete checkpoints require non-empty --evidence.")
        if goal["id"] == plan["goals"][-1]["id"] and not (verify_cmd and verify_evidence):
            sys.exit("codex-fable5: final story requires --verify-cmd and --verify-evidence.")
        if goal["id"] == plan["goals"][-1]["id"]:
            findings = blocking_findings()
            if findings:
                ids = ", ".join(str(finding.get("id", "?")) for finding in findings)
                sys.exit(
                    "codex-fable5: final story requires findings gate; "
                    f"{len(findings)} blocking findings remain ({ids})."
                )

    goal["status"] = args.status
    goal["evidence"] = evidence
    goal["verify_cmd"] = verify_cmd
    goal["verify_evidence"] = verify_evidence
    write_json(GOALS_FILE, plan)
    append_event(
        "checkpoint",
        id=goal["id"],
        status=args.status,
        evidence=evidence,
        verify_cmd=verify_cmd,
        verify_evidence=verify_evidence,
    )
    remaining = [item for item in plan["goals"] if item["status"] in OPEN_STATUSES]
    print(f"codex-fable5: {goal['id']} -> {args.status}")
    if terminal_incomplete_goals(plan["goals"]):
        summary = incomplete_terminal_summary(plan["goals"])
        print(f"codex-fable5: plan is not complete; {summary}.")
        if remaining:
            print(f"codex-fable5: {len(remaining)} open stories remain blocked.")
    elif remaining:
        print(f"codex-fable5: {len(remaining)} stories left")
    else:
        print("codex-fable5: all stories complete")


def cmd_status(_: argparse.Namespace) -> None:
    plan = load_plan()
    done = sum(1 for goal in plan["goals"] if goal["status"] == "complete")
    print(f"codex-fable5: {done}/{len(plan['goals'])} complete - {plan['brief']}")
    markers = {
        "complete": "done",
        "in_progress": "active",
        "pending": "pending",
        "failed": "failed",
        "blocked": "blocked",
    }
    for goal in plan["goals"]:
        marker = markers.get(goal["status"], goal["status"])
        print(f"  {goal['id']} [{marker}] {goal['title']}")
        if goal.get("evidence"):
            print(f"    evidence: {goal['evidence']}")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="codex-fable5 goals")
    sub = parser.add_subparsers(dest="command", required=True)

    create = sub.add_parser("create")
    create.add_argument("--brief", required=True)
    create.add_argument("--goal", action="append", default=[])
    create.add_argument("--force", action="store_true")

    sub.add_parser("next")

    checkpoint = sub.add_parser("checkpoint")
    checkpoint.add_argument("--id", required=True)
    checkpoint.add_argument("--status", required=True, choices=["complete", "failed", "blocked"])
    checkpoint.add_argument("--evidence", default="")
    checkpoint.add_argument("--verify-cmd", dest="verify_cmd", default="")
    checkpoint.add_argument("--verify-evidence", dest="verify_evidence", default="")

    sub.add_parser("status")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    handlers = {
        "create": cmd_create,
        "next": cmd_next,
        "checkpoint": cmd_checkpoint,
        "status": cmd_status,
    }
    handlers[args.command](args)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
