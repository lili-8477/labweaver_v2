#!/bin/bash
# Add a new labweaver user: create workspace, register htpasswd entry,
# spin up the per-user devcontainer.
#
# Usage: ./scripts/add-user.sh <username> [api_key] [options]

set -euo pipefail

HUB_DIR="$(cd "$(dirname "$0")/.." && pwd)"
HTPASSWD_FILE="${HUB_DIR}/htpasswd"
WORKSPACES_DIR="${HUB_DIR}/workspaces"
SHARED_DIR="${WORKSPACES_DIR}/shared"
# Hub infrastructure the user container joins. Defaults are the production
# hub (hub/docker-compose.yml); override all five to attach to another stack,
# e.g. the dev stack (see usage).
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
  hub/workspaces/<user>/               workspace root, bind-mounted at /workspace
  hub/workspaces/<user>/.env           DEEPSEEK_API_KEY / OLLAMA_API_KEY for this user
  hub/workspaces/<user>/.claude/       user-level bind sources (skills, agents, chats, claude-projects)
  hub/workspaces/<user>/projects/      project folders

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
# Load POSTGRES_PASSWORD from hub/.env into the shell scope so the docker run
# -e "PG_URL=..." substitution below sees it.
set -a
. "${ENV_FILE}"
set +a
echo "=== Adding user: ${USERNAME} ==="

# --- 1. Workspace + config scaffolding --------------------------------------
echo "[1/4] Creating workspace at ${WORKSPACE}"
mkdir -p "${WORKSPACE}/.claude/skills" \
         "${WORKSPACE}/.claude/agents" \
         "${WORKSPACE}/.claude/chats" \
         "${WORKSPACE}/.claude/claude-projects" \
         "${WORKSPACE}/.claude/commands" \
         "${WORKSPACE}/.dsh" \
         "${WORKSPACE}/.claude/hooks" \
         "${WORKSPACE}/local_projects" \
         "${WORKSPACE}/.latch" \
         "${WORKSPACE}/.ssh"
# .latch holds the Latch CLI token (used by scbench downloads). Credential —
# bind-mounted to /home/node/.latch so it survives container recreates.
chmod 700 "${WORKSPACE}/.latch"
# .ssh is the CHPC bridge's home — see hub/workspaces/shared/skills/chpc-bridge/.
# Bind-mounted to /home/node/.ssh inside the container so the SSH multiplex
# master socket + config + known_hosts survive container recreate. Must be
# 700 or ssh refuses to use it.
chmod 700 "${WORKSPACE}/.ssh"
if [[ ! -f "${WORKSPACE}/.ssh/config" ]]; then
    if [[ -n "$CHPC_UNID" ]]; then
        # --chpc-unid was passed: write an active config the user can use
        # immediately via the UI pill, and pre-seed notchpeak's host keys
        # so the very first connection doesn't trip on host-key prompts.
        cat > "${WORKSPACE}/.ssh/config" <<EOF
# CHPC bridge — auto-populated by add-user.sh.
# To change the UNID, edit the User line below.
# Reference: /workspace/shared/skills/chpc-bridge/SKILL.md

Host chpc-login
    HostName notchpeak.chpc.utah.edu
    User ${CHPC_UNID}
    ControlMaster auto
    ControlPath ~/.ssh/cm-%r@%h:%p
    ControlPersist 8h
    ServerAliveInterval 60
    ServerAliveCountMax 3
    StrictHostKeyChecking accept-new
    UserKnownHostsFile ~/.ssh/known_hosts
EOF
        if command -v ssh-keyscan >/dev/null 2>&1; then
            if ssh-keyscan -H notchpeak.chpc.utah.edu > "${WORKSPACE}/.ssh/known_hosts" 2>/dev/null \
                && [[ -s "${WORKSPACE}/.ssh/known_hosts" ]]; then
                chmod 600 "${WORKSPACE}/.ssh/known_hosts"
                echo "  pre-seeded notchpeak.chpc.utah.edu host keys"
            else
                rm -f "${WORKSPACE}/.ssh/known_hosts"
                echo "  warn: ssh-keyscan against notchpeak failed (no campus network / VPN?); accept-new will fill known_hosts on first connect"
            fi
        fi
    else
        # No --chpc-unid: write a commented template; the user can either
        # edit ${WORKSPACE}/.ssh/config to fill in their UNID, or re-run
        # add-user.sh later isn't supported — they edit by hand.
        cat > "${WORKSPACE}/.ssh/config" <<'SSHCFG'
# CHPC bridge — uncomment the Host stanza and fill in your UNID,
# then open the bridge via the "CHPC · open" pill in the UI.
# Reference: /workspace/shared/skills/chpc-bridge/SKILL.md
#
# Host chpc-login
#     HostName notchpeak.chpc.utah.edu
#     User <YOUR-UNID>
#     ControlMaster auto
#     ControlPath ~/.ssh/cm-%r@%h:%p
#     ControlPersist 8h
#     ServerAliveInterval 60
#     ServerAliveCountMax 3
#     StrictHostKeyChecking accept-new
#     UserKnownHostsFile ~/.ssh/known_hosts
SSHCFG
    fi
    chmod 600 "${WORKSPACE}/.ssh/config"
fi

# Seed a minimal Claude Code settings file so the CLI has sensible defaults.
if [[ ! -f "${WORKSPACE}/.claude/settings.json" ]]; then
    cat > "${WORKSPACE}/.claude/settings.json" <<'JSON'
{
  "$schema": "https://claude.ai/schemas/settings.json",
  "model": "deepseek-official/deepseek-v4-pro"
}
JSON
fi

# Install the self-driving tick harness skeleton (orchestrator command,
# tick-* subagents, hook scripts). Commands/agents use cp -n so user
# customizations survive a re-run; hooks use cp -f because they're
# harness-managed code that must track the skeleton (e.g. the CHPC job
# watcher needs the matching posttool_jobid.sh — drift breaks the chain).
# The harness itself is dormant unless a chat is switched to Auto in the
# composer's mode menu (the adapter then marks that session in ~/.claude/auto/).
SKELETON_DIR="${HUB_DIR}/skeleton/harness"
if [[ -d "${SKELETON_DIR}" ]]; then
    cp -n "${SKELETON_DIR}/commands/"*.md "${WORKSPACE}/.claude/commands/" 2>/dev/null || true
    cp -n "${SKELETON_DIR}/agents/"tick-*.md "${WORKSPACE}/.claude/agents/" 2>/dev/null || true
    cp -f "${SKELETON_DIR}/hooks/"*.sh "${WORKSPACE}/.claude/hooks/" 2>/dev/null || true
    chmod +x "${WORKSPACE}/.claude/hooks/"*.sh 2>/dev/null || true

    # Merge harness hook entries into settings.json, preserving inode (the
    # file is bind-mounted into the container; atomic-rename would break it).
    python3 "${HUB_DIR}/scripts/merge-harness-hooks.py" "${WORKSPACE}/.claude/settings.json"
fi

# Shared dirs — created on demand by the first user provisioning.
mkdir -p "${SHARED_DIR}/reference" "${SHARED_DIR}/projects" "${SHARED_DIR}/skills"

# Seed a slim user CLAUDE.md that imports the shared base via Claude Code's
# @<path> memory-import syntax. Shared content lives at /workspace/.labweaver/shared.md
# (bind-mounted from hub/workspaces/shared/CLAUDE.md, see MOUNTS below) so
# edits there flow live into every workspace. User-specific overrides go
# below the import line — later text wins on conflicts.
if [[ ! -f "${WORKSPACE}/CLAUDE.md" ]]; then
    cat > "${WORKSPACE}/CLAUDE.md" <<EOF
@/workspace/.labweaver/shared.md

# ${USERNAME} — local overrides

EOF
fi

# Per-user .env
if [[ ! -f "${WORKSPACE}/.env" ]]; then
    cat > "${WORKSPACE}/.env" <<EOF
# labweaver — user: ${USERNAME}
EOF
    if [[ -n "$API_KEY" ]]; then
        echo "DEEPSEEK_API_KEY=${API_KEY}" >> "${WORKSPACE}/.env"
    else
        echo "#DEEPSEEK_API_KEY=sk-your-key-here" >> "${WORKSPACE}/.env"
    fi
    if [[ -n "${OLLAMA_API_KEY:-}" ]]; then
        echo "OLLAMA_API_KEY=${OLLAMA_API_KEY}" >> "${WORKSPACE}/.env"
    else
        echo "#OLLAMA_API_KEY=your-ollama-cloud-key" >> "${WORKSPACE}/.env"
    fi
    chmod 600 "${WORKSPACE}/.env"
fi

# Register the labweaver-memory MCP server for this user. The adapter reads
# .mcp.json from the project root (cwd = /workspace inside the container,
# i.e. ${WORKSPACE} on the host). Merged via Python so we don't clobber
# any pre-existing servers (e.g. an adapter MCP added later); idempotent
# on re-runs since the same key just overwrites itself.
python3 "${HUB_DIR}/scripts/merge-mcp-config.py" "${WORKSPACE}/.mcp.json" "${USERNAME}"

# --- 2. HTTP Basic auth entry ------------------------------------------------
echo "[2/4] Setting up HTTP auth"
echo -n "Enter password for ${USERNAME}: "
read -rs PASSWORD
echo ""
touch "${HTPASSWD_FILE}"
if command -v htpasswd &>/dev/null; then
    htpasswd -b "${HTPASSWD_FILE}" "${USERNAME}" "${PASSWORD}"
else
    ENTRY=$(docker run --rm httpd:alpine htpasswd -nb "${USERNAME}" "${PASSWORD}")
    sed -i.bak "/^${USERNAME}:/d" "${HTPASSWD_FILE}" && rm -f "${HTPASSWD_FILE}.bak"
    echo "${ENTRY}" >> "${HTPASSWD_FILE}"
fi
docker exec "${NGINX_CONTAINER}" nginx -s reload >/dev/null 2>&1 || true

# --- 3. Service ID -----------------------------------------------------------
# Random secret recorded in hub/users.md (reused if the user existed before).
echo "[3/4] Service ID"
SERVICE_ID=$("${HUB_DIR}/scripts/service-id.sh" ensure "${USERNAME}")
echo "  service_id: ${SERVICE_ID}  (recorded in ${HUB_DIR}/users.md)"

# --- 4. Spin the container ---------------------------------------------------
echo "[4/4] Starting container"
MOUNTS=(
    # User's private projects — host and container use the same name so
    # the nginx /download/ endpoint (which serves directly from the host dir)
    # maps the UI path 1:1 without special rewrites.
    -v "${WORKSPACE}/local_projects:/workspace/local_projects"
    # Expose the user's whole .claude tree so the file explorer can browse and
    # edit agents/, chats/, claude-projects/, skills/, and settings.json. The
    # /home/node/.claude/* mounts below are still required (Claude Code reads
    # from there); this just adds a second view at /workspace/.claude/.
    -v "${WORKSPACE}/.claude:/workspace/.claude"
    -v "${WORKSPACE}/.env:/workspace/.env:ro"
    # Workspace-level instructions Claude Code auto-loads from cwd.
    -v "${WORKSPACE}/CLAUDE.md:/workspace/CLAUDE.md:ro"
    # Project-scoped MCP server registry — Claude Code reads .mcp.json
    # from cwd (/workspace) on launch. Single-file mount keeps the inode
    # stable across host edits (atomic-rename would break the mount).
    -v "${WORKSPACE}/.mcp.json:/workspace/.mcp.json:ro"
    # Shared CLAUDE.md, mounted live so org-wide edits propagate without
    # touching per-user files. The user CLAUDE.md @-imports this path.
    -v "${SHARED_DIR}/CLAUDE.md:/workspace/.labweaver/shared.md:ro"
    # Skills are split: per-user skills at skills-user, org-wide at skills-shared.
    # The entrypoint symlinks both into ~/.claude/skills/ so Claude Code
    # auto-discovers them. User skills win on name collisions.
    -v "${WORKSPACE}/.claude/skills:/home/node/.claude/skills-user"
    -v "${WORKSPACE}/.claude/agents:/home/node/.claude/agents"
    -v "${WORKSPACE}/.claude/commands:/home/node/.claude/commands"
    -v "${WORKSPACE}/.claude/hooks:/home/node/.claude/hooks"
    -v "${WORKSPACE}/.claude/settings.json:/home/node/.claude/settings.json"
    # Persist Claude Code session JSONLs across container recreations.
    -v "${WORKSPACE}/.claude/claude-projects:/home/node/.claude/projects"
    # DeepSeek Harness state (session logs needed for resume, cordis patch).
    -v "${WORKSPACE}/.dsh:/home/node/.dsh"
    -v "${WORKSPACE}/.latch:/home/node/.latch"
    # CHPC SSH bridge: config + known_hosts + multiplex socket all live here.
    -v "${WORKSPACE}/.ssh:/home/node/.ssh"
    -v "${SHARED_DIR}/reference:/workspace/shared/reference:ro"
    -v "${SHARED_DIR}/projects:/workspace/shared/projects"
    -v "${SHARED_DIR}/skills:/home/node/.claude/skills-shared:ro"
    # Also expose the shared skills tree under /workspace so the file
    # explorer can render it for browsing. Read-only; users edit personal
    # skills under their per-user .claude/skills mount above.
    -v "${SHARED_DIR}/skills:/workspace/shared/skills:ro"
)

for spec in "${DATA_MOUNTS[@]+"${DATA_MOUNTS[@]}"}"; do
    if [[ "$spec" == *":"* ]]; then
        host="${spec%%:*}"; tgt="${spec#*:}"
    else
        host="$spec"; tgt="/workspace/data/$(basename "$spec")"
    fi
    [[ -d "$host" ]] || mkdir -p "$host"
    MOUNTS+=(-v "${host}:${tgt}")
done

# GPU passthrough: pass --gpus all when nvidia-container-toolkit is present
# on the host. Without the toolkit `--gpus all` fails hard, so we detect.
# Override with GPU=0 to force-disable.
GPU_FLAGS=()
if [[ "${GPU:-auto}" != "0" ]] && command -v nvidia-ctk >/dev/null 2>&1; then
    GPU_FLAGS=(--gpus all)
    echo "  [gpu] --gpus all (detected nvidia-container-toolkit)"
fi

docker run -d \
    --name "${CONTAINER}" \
    --network "${NETWORK}" \
    --restart unless-stopped \
    "${GPU_FLAGS[@]}" \
    -e "SERVICE_ID=${SERVICE_ID}" \
    -e "NATS_SERVERS=nats://${NATS_HOST}:4222" \
    -e "NATS_USER=agent" \
    -e "WORKSPACE_ROOT=/workspace" \
    -e "DEFAULT_PROJECT=/workspace" \
    -e "PG_URL=postgres://labweaver:${POSTGRES_PASSWORD}@${PG_HOST}:5432/labweaver" \
    -e "USERNAME=${USERNAME}" \
    -e "HOME=/home/node" \
    -e "MEMORY_API_URL=http://${INDEXER_HOST}:8400" \
    -e "MEMORY_ENABLED=1" \
    "${MOUNTS[@]}" \
    -w /workspace \
    "${IMAGE}"

sleep 2
if ! docker ps --format '{{.Names}}' | grep -q "^${CONTAINER}$"; then
    echo "Error: container failed to start. Logs:"
    docker logs "${CONTAINER}" | tail -30
    exit 1
fi

# Chown the inherited /venv to node so runtime pip installs (torch,
# scSurvival, jupyter, etc) actually land. Runs once per container,
# takes ~10s, lives in the container's own overlay — NOT in the image.
docker exec -u root "${CONTAINER}" chown -R node:node /venv 2>/dev/null \
    && echo "  chown /venv -> node:node OK" \
    || echo "  chown /venv skipped (already owned, or container not ready)"

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
  Username:      ${USERNAME}  (HTTP Basic)
  ${CHPC_LINE}

Drop skills into:
  ${WORKSPACE}/.claude/skills/<name>/SKILL.md
SUMMARY
