#!/usr/bin/env python3
"""Validate Fable section coverage against the Codex adaptation matrix."""

from __future__ import annotations

import argparse
import re
import sys
from collections import Counter
from pathlib import Path

ALLOWED_STATUSES = {"implemented", "adapted", "unsupported", "not_applicable"}


def normalize_status(raw: str) -> str:
    return raw.strip().lower().replace(" ", "_").replace("-", "_")


def extract_source_sections(path: Path) -> list[str]:
    stack: list[str] = []
    sections: list[str] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        match = re.match(r"^(#{1,6})\s+(.+?)\s*$", line)
        if not match:
            continue
        level = len(match.group(1))
        title = match.group(2).strip()
        stack = stack[: level - 1]
        stack.append(title)
        if level > 1:
            sections.append(" > ".join(stack[1:]))
    return sections


def extract_matrix(path: Path) -> dict[str, str]:
    rows: dict[str, str] = {}
    for line_no, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        stripped = line.strip()
        if not stripped.startswith("|"):
            continue
        cells = [cell.strip() for cell in stripped.strip("|").split("|")]
        if len(cells) < 2 or cells[0].lower() in {"source section", "---"}:
            continue
        match = re.fullmatch(r"`(.+?)`", cells[0])
        if not match:
            continue
        section = match.group(1)
        status = normalize_status(cells[1])
        if status not in ALLOWED_STATUSES:
            sys.exit(f"{path}:{line_no}: invalid status {cells[1]!r} for {section!r}")
        if section in rows:
            sys.exit(f"{path}:{line_no}: duplicate section {section!r}")
        rows[section] = status
    if not rows:
        sys.exit(f"{path}: no coverage rows found")
    return rows


def main() -> int:
    parser = argparse.ArgumentParser()
    skill_root = Path(__file__).resolve().parents[1]
    parser.add_argument(
        "--matrix",
        type=Path,
        default=skill_root / "references" / "coverage-matrix.md",
        help="Coverage matrix markdown file.",
    )
    parser.add_argument(
        "--source",
        type=Path,
        help="Optional CLAUDE-FABLE-5.md source file. When supplied, headings must match the matrix.",
    )
    args = parser.parse_args()

    matrix_rows = extract_matrix(args.matrix)
    status_counts = Counter(matrix_rows.values())

    if args.source:
        source_sections = extract_source_sections(args.source)
        source_set = set(source_sections)
        matrix_set = set(matrix_rows)
        missing = sorted(source_set - matrix_set)
        extra = sorted(matrix_set - source_set)
        if missing or extra:
            if missing:
                print("Missing source sections:", file=sys.stderr)
                for item in missing:
                    print(f"  - {item}", file=sys.stderr)
            if extra:
                print("Extra matrix sections:", file=sys.stderr)
                for item in extra:
                    print(f"  - {item}", file=sys.stderr)
            return 1
        pct = (len(matrix_rows) / len(source_sections)) * 100 if source_sections else 0
        print(
            f"codex-fable5: source headings {len(source_sections)}, "
            f"matrix rows {len(matrix_rows)}, accounted {len(matrix_rows)}/{len(source_sections)} ({pct:.1f}%)"
        )
    else:
        print(f"codex-fable5: matrix rows {len(matrix_rows)}")

    print("codex-fable5: statuses " + ", ".join(f"{key}={status_counts[key]}" for key in sorted(status_counts)))
    print("codex-fable5: coverage matrix valid")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
