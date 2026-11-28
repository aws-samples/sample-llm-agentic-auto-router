#!/usr/bin/env bash
# Starts the LiteLLM proxy on 127.0.0.1:4000 for live.ts. Run from anywhere; uses its own uv cache dir under results/.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
# 1.111.0: the version docs/integrations/litellm.zh-CN.md verified; native Bedrock Chat Completions since 1.106.0 (PR #44307).
LITELLM_VERSION="${LITELLM_VERSION:-1.111.0}"
: "${LITELLM_MASTER_KEY:?set LITELLM_MASTER_KEY}"
: "${LLMAR_EXT_REGION:?set LLMAR_EXT_REGION}"
: "${AWS_PROFILE:?set AWS_PROFILE to the spike-account profile}"
mkdir -p "$here/results"
cd "$here/results"   # never run the proxy from a directory with project code in it
exec uvx --from "litellm[proxy]==${LITELLM_VERSION}" litellm --config "$here/litellm.config.yaml" --host 127.0.0.1 --port 4000
