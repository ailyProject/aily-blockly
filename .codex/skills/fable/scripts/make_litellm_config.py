#!/usr/bin/env python3
"""Generate a small LiteLLM config for routing a Codex provider to Anthropic."""

from __future__ import annotations

import argparse
from pathlib import Path


def q(value: str) -> str:
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


def build_config(model: str, alias: str) -> str:
    provider_model = model if model.startswith("anthropic/") else f"anthropic/{model}"
    return "\n".join(
        [
            "model_list:",
            "  - model_name: " + q(alias),
            "    litellm_params:",
            "      model: " + q(provider_model),
            "      api_key: os.environ/ANTHROPIC_API_KEY",
            "",
            "litellm_settings:",
            "  modify_params: true",
            "  drop_params: true",
            "",
        ]
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", default="claude-fable-5", help="Anthropic model name.")
    parser.add_argument("--alias", default=None, help="Model name Codex should send to LiteLLM.")
    parser.add_argument("--output", "-o", default="-", help="Output YAML path, or '-' for stdout.")
    args = parser.parse_args()

    alias = args.alias or args.model.removeprefix("anthropic/")
    text = build_config(args.model, alias)

    if args.output == "-":
        print(text, end="")
    else:
        path = Path(args.output)
        path.write_text(text, encoding="utf-8")
        print(f"Wrote {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
