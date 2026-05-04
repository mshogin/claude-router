#!/usr/bin/env bash
# Generate ~/.claude-code-router/config.json from ~/.claude-router/models.yaml.
#
# Per-model auth (priority order):
#   1. api_key:     "<plain-string>"  - direct
#   2. api_key_env: ENV_VAR_NAME      - read from environment
#   3. auth_secret: <name>            - $SECRETS_DIR/<name>.gpg via gpg agent,
#                                       OR env CR_SECRET_<UPPER_NAME> override
#   4. (none)                         - send "not-needed"
#
# Override paths via env:
#   CONFIG_DIR        default: ~/.claude-router
#   CCR_DIR           default: ~/.claude-code-router
#   SECRETS_DIR       default: ~/secrets
#   ROUTER_LIB_DIR    default: <repo>/lib

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

CONFIG_DIR="${CONFIG_DIR:-${HOME}/.claude-router}"
CCR_DIR="${CCR_DIR:-${HOME}/.claude-code-router}"
SECRETS_DIR="${SECRETS_DIR:-${HOME}/secrets}"
ROUTER_LIB_DIR="${ROUTER_LIB_DIR:-${REPO_DIR}/lib}"

MODELS_YAML="${CONFIG_DIR}/models.yaml"
CONFIG_JSON="${CCR_DIR}/config.json"
ROUTER_JS="${ROUTER_LIB_DIR}/router.js"

if [ ! -f "${MODELS_YAML}" ]; then
  echo "ERROR: ${MODELS_YAML} not found." >&2
  echo "Hint: cp ${REPO_DIR}/examples/models.example.yaml ${MODELS_YAML}" >&2
  exit 1
fi

mkdir -p "${CCR_DIR}"

python3 - "${MODELS_YAML}" "${CONFIG_JSON}" "${ROUTER_JS}" "${SECRETS_DIR}" <<'PYEOF'
import json
import os
import subprocess
import sys

import yaml

models_path, config_path, router_js_path, secrets_dir = sys.argv[1:5]

with open(models_path, "r", encoding="utf-8") as f:
    cat = yaml.safe_load(f)

router_cfg = cat["router"]
models = cat["models"]


def decrypt_gpg(name: str) -> str:
    path = os.path.join(secrets_dir, f"{name}.gpg")
    if not os.path.exists(path):
        sys.exit(f"ERROR: secret file not found: {path}")
    out = subprocess.run(
        ["gpg", "--quiet", "--batch", "--decrypt", path],
        capture_output=True, check=True,
    )
    return out.stdout.decode("utf-8").strip()


def resolve_api_key(m: dict) -> str:
    """Priority: api_key > api_key_env > auth_secret > 'not-needed'."""
    if m.get("api_key"):
        return m["api_key"]
    env_name = m.get("api_key_env")
    if env_name:
        val = os.environ.get(env_name)
        if not val:
            sys.exit(
                f"ERROR: model '{m['id']}' has api_key_env={env_name} "
                f"but environment variable is empty."
            )
        return val
    secret = m.get("auth_secret")
    if secret:
        env_override = "CR_SECRET_" + secret.upper().replace("-", "_")
        if os.environ.get(env_override):
            return os.environ[env_override]
        return decrypt_gpg(secret)
    return "not-needed"


providers = []
for m in models:
    if "context_window" not in m:
        sys.exit(
            f"ERROR: model '{m.get('id', '?')}' is missing required field "
            f"'context_window' (total tokens the model accepts: input + output). "
            f"Add e.g. `context_window: 32768`."
        )
    base_url = m["base_url"].rstrip("/")
    if not base_url.endswith("/chat/completions"):
        base_url = base_url + "/chat/completions"

    provider = {
        "name": m["id"],
        "api_base_url": base_url,
        "api_key": resolve_api_key(m),
        "models": [m["model_name"]],
    }

    # max_tokens is clamped per-request by lib/router.js based on model
    # context_window and actual input size — no static maxtoken transformer.
    use_list = []
    for tname in m.get("extra_transformers", []) or []:
        use_list.append(tname)
    # cleancache strips Anthropic prompt-cache fields that OpenAI-shape
    # upstreams don't understand. Always safe.
    use_list.append("cleancache")
    provider["transformer"] = {"use": use_list}
    providers.append(provider)

fallback = router_cfg["fallback_model"]
fallback_provider = next((p for p in providers if p["name"] == fallback), None)
if fallback_provider is None:
    sys.exit(f"ERROR: fallback_model '{fallback}' not found in models")
fallback_pair = f"{fallback_provider['name']},{fallback_provider['models'][0]}"

config = {
    "LOG": True,
    "LOG_LEVEL": "info",
    "API_TIMEOUT_MS": 600000,
    "CUSTOM_ROUTER_PATH": router_js_path,
    "Providers": providers,
    "Router": {
        "default": fallback_pair,
        "background": fallback_pair,
        "think": fallback_pair,
        "longContext": fallback_pair,
    },
    "_router_meta": {
        "promptlint_url": router_cfg["promptlint_url"],
        "fallback_model": fallback,
        "quarantine_minutes": router_cfg.get("quarantine_minutes", 5),
        "scoring_weights": router_cfg["scoring_weights"],
        "models": [
            {
                "id": m["id"],
                "model_name": m["model_name"],
                "strengths": m.get("strengths", {}),
                "complexity_max": m.get("complexity_max", "high"),
                "context_window": m["context_window"],
                "max_output_tokens": m.get("max_output_tokens"),
                "output_safety_margin": m.get("output_safety_margin", 256),
            }
            for m in models
        ],
    },
}

# Write a side-car for footer-proxy (quarantine + model list).
proxy_meta_path = os.path.join(os.path.dirname(config_path), "footer-proxy.json")
proxy_meta = {
    "quarantine_minutes": router_cfg.get("quarantine_minutes", 5),
    "models": [
        {"id": m["id"], "model_name": m["model_name"]} for m in models
    ],
}
with open(proxy_meta_path, "w", encoding="utf-8") as f:
    json.dump(proxy_meta, f, indent=2, ensure_ascii=False)

with open(config_path, "w", encoding="utf-8") as f:
    json.dump(config, f, indent=2, ensure_ascii=False)

print(f"Generated {config_path}")
print(f"  Providers:   {len(providers)}")
print(f"  Fallback:    {fallback_pair}")
print(f"  Router:      {router_js_path}")
print(f"  Proxy meta:  {proxy_meta_path}")
PYEOF

chmod 600 "${CONFIG_JSON}"
echo "Config permissions set to 600 (contains API keys)"
