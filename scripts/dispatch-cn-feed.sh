#!/usr/bin/env bash
set -euo pipefail

product=${1:?Expected a product}
version=${2:?Expected a release version}
source_run_id=${SOURCE_RUN_ID:-${GITHUB_RUN_ID:?}}
source_attempt=${SOURCE_ATTEMPT:-${GITHUB_RUN_ATTEMPT:?}}
source_sha=${SOURCE_SHA:-${GITHUB_SHA:?}}
repository=ailyProject/aily-services

run_id=$(gh api --method POST "repos/$repository/actions/workflows/domestic-feed.yml/dispatches" \
  -H 'X-GitHub-Api-Version: 2022-11-28' -f ref=main -F return_run_details=true \
  -f "inputs[product]=$product" -f "inputs[version]=$version" \
  -f "inputs[source_run_id]=$source_run_id" -f "inputs[source_attempt]=$source_attempt" \
  -f "inputs[source_sha]=$source_sha" --jq '.workflow_run_id')
if [[ ! $run_id =~ ^[1-9][0-9]*$ ]]; then
  echo 'GitHub did not return a domestic feed workflow run ID' >&2
  exit 1
fi

echo "Waiting for https://github.com/$repository/actions/runs/$run_id"
while (( SECONDS < 3600 )); do
  # A newly dispatched run may take a moment to become readable.
  if state=$(gh api "repos/$repository/actions/runs/$run_id" --jq 'if .status == "completed" then .conclusion else "pending" end'); then
    case "$state" in
      success) exit 0 ;;
      pending) ;;
      *) echo "Domestic feed run $run_id finished with $state" >&2; exit 1 ;;
    esac
  fi
  sleep 15
done
echo "Timed out waiting for domestic feed run $run_id" >&2
exit 1
