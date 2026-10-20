#!/bin/bash
# Recreate a user's container (e.g. after bumping the image) from the
# container spec add-user.sh saved, keeping the workspace and service ID.
# The workspace is refreshed first (harness skeleton, hook entries, memory
# MCP registration), so a recreate also brings an older workspace up to date.
#
# Usage: [IMAGE=labweaver:dsh-dev] recreate-user.sh <username>
# IMAGE replaces the image in the spec; other changes: edit
# hub/workspaces/<user>/container.env.

set -euo pipefail

HUB_DIR="$(cd "$(dirname "$0")/.." && pwd)"
. "${HUB_DIR}/scripts/lib/user-container.sh"
ENV_FILE="${HUB_DIR}/.env"

USERNAME="${1:-}"
if [[ -z "$USERNAME" ]]; then
    echo "Usage: [IMAGE=labweaver:latest] $0 <username>"
    exit 1
fi

CONTAINER="labweaver-${USERNAME}"
WORKSPACE="${WORKSPACES_DIR}/${USERNAME}"

[[ -d "$WORKSPACE" ]] || { echo "No workspace at ${WORKSPACE}"; exit 1; }
[[ -f "$ENV_FILE" ]] || { echo "Missing ${ENV_FILE}; run add-user.sh once (or create the file) to generate POSTGRES_PASSWORD."; exit 1; }
# POSTGRES_PASSWORD for the container's PG_URL.
set -a
. "${ENV_FILE}"
set +a

spec_load "${USERNAME}"
spec_save "${USERNAME}"
prepare_workspace "${USERNAME}"

# Keep the user's existing service ID so their frontend link keeps working.
SERVICE_ID=$("${HUB_DIR}/scripts/service-id.sh" get "${USERNAME}") \
    || { echo "Add one with: ${HUB_DIR}/scripts/service-id.sh ensure ${USERNAME}"; exit 1; }

# The old container steps aside as <name>-old and comes back if the new one
# fails to start.
OLD=""
if docker ps -a --format '{{.Names}}' | grep -q "^${CONTAINER}$"; then
    OLD="${CONTAINER}-old"
    docker rm -f "$OLD" >/dev/null 2>&1 || true
    docker stop "$CONTAINER" >/dev/null
    docker rename "$CONTAINER" "$OLD"
fi
if ! run_user_container "${USERNAME}"; then
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
    if [[ -n "$OLD" ]]; then
        docker rename "$OLD" "$CONTAINER" && docker start "$CONTAINER" >/dev/null
        echo "Restored the previous ${CONTAINER}." >&2
    fi
    exit 1
fi
[[ -z "$OLD" ]] || docker rm "$OLD" >/dev/null

echo "Recreated ${CONTAINER} with image ${IMAGE}."
