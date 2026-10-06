#!/bin/bash
# Per-user service IDs: random secrets recorded in hub/users.md.
#
# A service ID is the NATS address of a user's adapter
# (pantheon.service.<service_id>); anyone holding it can drive that user's
# agent, so it is random (not derived from the username) and users.md is
# gitignored and chmod 600.
#
# Usage: service-id.sh ensure <username>   print the ID, creating one if absent
#        service-id.sh get    <username>   print the ID; exit 1 if absent
#        service-id.sh remove <username>   delete the user's row
#
# USERS_FILE overrides the registry path (default: hub/users.md).

set -euo pipefail

HUB_DIR="$(cd "$(dirname "$0")/.." && pwd)"
USERS_FILE="${USERS_FILE:-${HUB_DIR}/users.md}"

usage() { echo "Usage: $0 ensure|get|remove <username>" >&2; exit 2; }
[[ $# -eq 2 ]] || usage
CMD="$1"
USERNAME="$2"
[[ "$USERNAME" =~ ^[a-z0-9][a-z0-9-]*$ ]] || { echo "invalid username: ${USERNAME}" >&2; exit 2; }

init_file() {
    [[ -f "$USERS_FILE" ]] && return
    (umask 077 && cat > "$USERS_FILE" <<'MD'
# LabWeaver users

SECRET — a service ID grants full control of that user's agent. Hand each
user only their own ID; never commit this file.

| username | service_id | created |
|---|---|---|
MD
    )
}

lookup() {
    [[ -f "$USERS_FILE" ]] || return 0
    awk -F'|' -v u="$USERNAME" '{
        name = $2; id = $3
        gsub(/ /, "", name); gsub(/ /, "", id)
        if (name == u && id ~ /^[0-9a-f]+$/ && length(id) == 64) { print id; exit }
    }' "$USERS_FILE"
}

case "$CMD" in
    get)
        id="$(lookup)"
        [[ -n "$id" ]] || { echo "no service ID for '${USERNAME}' in ${USERS_FILE}" >&2; exit 1; }
        echo "$id"
        ;;
    ensure)
        id="$(lookup)"
        if [[ -z "$id" ]]; then
            init_file
            id="$(openssl rand -hex 32)"
            echo "| ${USERNAME} | ${id} | $(date +%Y-%m-%d) |" >> "$USERS_FILE"
        fi
        echo "$id"
        ;;
    remove)
        [[ -f "$USERS_FILE" ]] || exit 0
        tmp="$(mktemp)"
        awk -F'|' -v u="$USERNAME" '{
            name = $2; id = $3; gsub(/ /, "", name); gsub(/ /, "", id)
            if (!(name == u && id ~ /^[0-9a-f]+$/ && length(id) == 64)) print
        }' "$USERS_FILE" > "$tmp"
        # Rewrite in place so the file keeps its mode (600).
        cat "$tmp" > "$USERS_FILE"
        rm -f "$tmp"
        ;;
    *) usage ;;
esac
