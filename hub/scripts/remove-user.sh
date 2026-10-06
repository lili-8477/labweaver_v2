#!/bin/bash
# Remove a labweaver user — stops container, removes htpasswd entry and
# retires the user's service ID in hub/users.md.
# Workspace files are PRESERVED on disk; rm them manually if intended.

set -euo pipefail

HUB_DIR="$(cd "$(dirname "$0")/.." && pwd)"
HTPASSWD_FILE="${HUB_DIR}/htpasswd"

USERNAME="${1:-}"
if [[ -z "$USERNAME" ]]; then
    echo "Usage: $0 <username>"
    exit 1
fi
# Same rule as add-user.sh; also keeps regex metacharacters out of the sed below.
if ! [[ "$USERNAME" =~ ^[a-z0-9][a-z0-9-]*$ ]]; then
    echo "Error: username must be lowercase alphanumeric (hyphens allowed, no leading hyphen)"
    exit 1
fi

CONTAINER="labweaver-${USERNAME}"

if docker ps -a --format '{{.Names}}' | grep -q "^${CONTAINER}$"; then
    echo "Stopping ${CONTAINER}..."
    docker stop "${CONTAINER}" >/dev/null
    docker rm "${CONTAINER}" >/dev/null
else
    echo "No container named ${CONTAINER}."
fi

if [[ -f "${HTPASSWD_FILE}" ]]; then
    sed -i.bak "/^${USERNAME}:/d" "${HTPASSWD_FILE}"
    rm -f "${HTPASSWD_FILE}.bak"
    docker exec labweaver-nginx nginx -s reload >/dev/null 2>&1 || true
    echo "Removed htpasswd entry for ${USERNAME}."
fi

"${HUB_DIR}/scripts/service-id.sh" remove "${USERNAME}"
echo "Retired service ID for ${USERNAME}."

echo "Workspace preserved at ${HUB_DIR}/workspaces/${USERNAME}/"
