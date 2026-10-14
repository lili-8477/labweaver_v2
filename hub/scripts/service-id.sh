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
#        service-id.sh map                   rewrite the nginx service routes
#
# USERS_FILE overrides the registry path (default: hub/users.md).
# ensure and remove also rewrite ROUTES_FILE (default: hub/service-routes.map),
# which nginx's file routes use to find the user from the app's service-ID
# cookie (see hub/nginx.conf).

set -euo pipefail

HUB_DIR="$(cd "$(dirname "$0")/.." && pwd)"
USERS_FILE="${USERS_FILE:-${HUB_DIR}/users.md}"
ROUTES_FILE="${ROUTES_FILE:-${HUB_DIR}/service-routes.map}"

usage() { echo "Usage: $0 ensure|get|remove <username> | map" >&2; exit 2; }
CMD="${1:-}"
if [[ "$CMD" == map ]]; then
    [[ $# -eq 1 ]] || usage
else
    [[ $# -eq 2 ]] || usage
    USERNAME="$2"
    [[ "$USERNAME" =~ ^[a-z0-9][a-z0-9-]*$ ]] || { echo "invalid username: ${USERNAME}" >&2; exit 2; }
fi

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

# nginx map entries "<service_id> <username>;", one per registered user.
# Rewritten in place: nginx bind-mounts this file, and a mount keeps
# pointing at the old inode when a file is replaced.
write_map() {
    local entries=""
    [[ -f "$USERS_FILE" ]] && entries="$(awk -F'|' '{
        name = $2; id = $3; gsub(/ /, "", name); gsub(/ /, "", id)
        if (name ~ /^[a-z0-9][a-z0-9-]*$/ && id ~ /^[0-9a-f]+$/ && length(id) == 64) print id " " name ";"
    }' "$USERS_FILE")"
    (umask 077 && printf '%s\n' "$entries" > "$ROUTES_FILE")
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
        write_map
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
        write_map
        ;;
    map) write_map ;;
    *) usage ;;
esac
