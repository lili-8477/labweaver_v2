#!/bin/bash
# Add a new labweaver user: create workspace, register a service ID,
# spin up the per-user devcontainer.
#
# Usage: ./scripts/add-user.sh <username> [api_key] [options]

set -euo pipefail

HUB_DIR="$(cd "$(dirname "$0")/.." && pwd)"
. "${HUB_DIR}/scripts/lib/user-container.sh"
# Hub infrastructure the user container joins. Defaults are the production
# hub (hub/docker-compose.yml); override all five to attach to another stack,
# e.g. the dev stack (see usage). They are saved in the user's container spec,
# so recreate-user.sh reattaches to the same stack.
NETWORK="${NETWORK:-labweaver_labweaver-net}"
NATS_HOST="${NATS_HOST:-labweaver-nats}"
PG_HOST="${PG_HOST:-labweaver-postgres}"
INDEXER_HOST="${INDEXER_HOST:-labweaver-indexer}"
NGINX_CONTAINER="${NGINX_CONTAINER:-labweaver-nginx}"
ENV_FILE="${HUB_DIR}/.env"

ensure_hub_env() {
    if [[ -f "$ENV_FILE" ]] && grep -q '^POSTGRES_PASSWORD=' "$ENV_FILE"; then
        return
    fi
    local pw
    pw=$(openssl rand -base64 32 | tr -d '=+/')
    touch "$ENV_FILE"
    chmod 600 "$ENV_FILE"
    if grep -q '^POSTGRES_PASSWORD=' "$ENV_FILE" 2>/dev/null; then
        return
    fi
    {
        echo "# labweaver hub secrets — do not commit"
        echo "POSTGRES_PASSWORD=${pw}"
    } >> "$ENV_FILE"
    echo "Generated ${ENV_FILE} with a random POSTGRES_PASSWORD."
}

IMAGE="${IMAGE:-labweaver:dev}"
USERNAME=""
API_KEY=""
DATA_MOUNTS=()
CHPC_UNID=""

usage() {
    cat <<'HELP'
Usage: add-user.sh <username> [deepseek_api_key] [options]

OLLAMA_API_KEY in the calling environment is also written to the user's .env
(enables the Ollama Cloud provider).

Options:
  --data, -d PATH[:MOUNT]   Mount a host dir (repeatable). Defaults to /workspace/data/<dirname>.
  --chpc-unid, -c UNID      CHPC username (e.g. u0123456). When set, the
                            workspace ssh config is pre-populated for the
                            chpc-login alias and notchpeak's host keys are
                            pre-fetched, so the user can click "CHPC · open"
                            in the UI without further setup.
  --image, -i IMAGE         Override container image (default: labweaver:dev).
  --help, -h                Show this help.

Examples:
  add-user.sh alice sk-xxxxx
  OLLAMA_API_KEY=xxxx add-user.sh dave
  add-user.sh bob --data /home/bob/dataset1 --data /shared/refs:/workspace/shared/refs:ro
  add-user.sh carol --chpc-unid u0123456

  # Attach to the dev stack (docker-compose.dev.yml) instead of the prod hub:
  NETWORK=labweaver-dev_labweaver-dev-net NATS_HOST=labweaver-dev-nats \
  PG_HOST=labweaver-dev-postgres INDEXER_HOST=labweaver-dev-indexer \
  NGINX_CONTAINER=labweaver-dev-web add-user.sh erin --image labweaver:dsh-dev

The script creates:
  hub/workspaces/<user>/               workspace root (its parts are bind-mounted under /workspace)
  hub/workspaces/<user>/container.env  container spec: image, hub hosts, data mounts (recreate-user.sh reads it)
  hub/workspaces/<user>/.env           DEEPSEEK_API_KEY / OLLAMA_API_KEY for this user
  hub/workspaces/<user>/.labweaver/    the labweaver folder (skills, commands, agents, hooks, settings.json, transcripts)
  hub/workspaces/<user>/local_projects/ project folders

And spins a container named "labweaver-<user>" on the labweaver-net network.
HELP
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --data|-d)
            shift
            [[ $# -eq 0 ]] && { echo "Error: --data requires a path"; exit 1; }
            DATA_MOUNTS+=("$1"); shift
            ;;
        --chpc-unid|-c)
            shift
            [[ $# -eq 0 ]] && { echo "Error: --chpc-unid requires a UNID"; exit 1; }
            CHPC_UNID="$1"; shift
            ;;
        --image|-i)
            shift
            [[ $# -eq 0 ]] && { echo "Error: --image requires a value"; exit 1; }
            IMAGE="$1"; shift
            ;;
        --help|-h) usage; exit 0 ;;
        *)
            if [[ -z "$USERNAME" ]]; then USERNAME="$1"
            elif [[ -z "$API_KEY" ]]; then API_KEY="$1"
            else echo "Unexpected argument: $1"; exit 1
            fi
            shift
            ;;
    esac
done

if [[ -z "$USERNAME" ]]; then usage; exit 1; fi
if ! [[ "$USERNAME" =~ ^[a-z0-9][a-z0-9-]*$ ]]; then
    echo "Error: username must be lowercase alphanumeric (hyphens allowed, no leading hyphen)"
    exit 1
fi

if ! docker network inspect "${NETWORK}" >/dev/null 2>&1; then
    echo "Error: network '${NETWORK}' not found. Run 'docker compose up -d' first."
    exit 1
fi

CONTAINER="labweaver-${USERNAME}"
WORKSPACE="${WORKSPACES_DIR}/${USERNAME}"

if docker ps -a --format '{{.Names}}' | grep -q "^${CONTAINER}$"; then
    echo "Error: user '${USERNAME}' already exists. Remove first with ./scripts/remove-user.sh ${USERNAME}"
    exit 1
fi

ensure_hub_env
# POSTGRES_PASSWORD for the container's PG_URL.
set -a
. "${ENV_FILE}"
set +a
echo "=== Adding user: ${USERNAME} ==="

# --- 1. Workspace and container spec ----------------------------------------
echo "[1/3] Preparing workspace at ${WORKSPACE}"
for i in "${!DATA_MOUNTS[@]}"; do DATA_MOUNTS[$i]="$(resolve_data_mount "${DATA_MOUNTS[$i]}")"; done
mkdir -p "${WORKSPACE}"
spec_save "${USERNAME}"
prepare_workspace "${USERNAME}"

# --- 2. Service ID -----------------------------------------------------------
# Random secret recorded in hub/users.md (reused if the user existed before).
echo "[2/3] Service ID"
SERVICE_ID=$("${HUB_DIR}/scripts/service-id.sh" ensure "${USERNAME}")
echo "  service_id: ${SERVICE_ID}  (recorded in ${HUB_DIR}/users.md)"
# ensure rewrote hub/service-routes.map; reload so file routes reach this user.
docker exec "${NGINX_CONTAINER}" nginx -s reload >/dev/null 2>&1 || true

# --- 3. Spin the container ---------------------------------------------------
echo "[3/3] Starting container"
run_user_container "${USERNAME}"

if [[ -n "$CHPC_UNID" ]]; then
    CHPC_LINE="CHPC bridge:   pre-configured for UNID '${CHPC_UNID}' — click \"CHPC · open\" in the UI"
else
    CHPC_LINE="CHPC bridge:   not configured — edit ${WORKSPACE}/.ssh/config or rerun with --chpc-unid"
fi

cat <<SUMMARY

=== User '${USERNAME}' created ===
  Container:  ${CONTAINER}
  Workspace:  ${WORKSPACE}
  Image:      ${IMAGE}

Frontend connection:
  WebSocket URL: ws://localhost:8088/ws/   (front with TLS for remote access)
  Service ID:    ${SERVICE_ID}
  ${CHPC_LINE}

Drop skills into:
  ${WORKSPACE}/.labweaver/skills/<name>/SKILL.md
SUMMARY
