#!/bin/bash
# User container provisioning against a fake docker: recreate-user.sh must
# rebuild exactly the container add-user.sh made, keep the user's files, and
# put the old container back when the new one fails.
#
# Usage: hub/scripts/test/user-container.test.sh   (no docker needed)

set -euo pipefail

SRC="$(cd "$(dirname "$0")/../.." && pwd)"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT

# A hub of our own: the scripts, the skeleton, the shared CLAUDE.md.
HUB="$T/hub"
mkdir -p "$HUB/workspaces/shared" "$T/bin"
cp -r "$SRC/scripts" "$SRC/skeleton" "$HUB/"
touch "$HUB/workspaces/shared/CLAUDE.md"
echo "POSTGRES_PASSWORD=pw" > "$HUB/.env"

# Fake docker: logs every call, tracks container names, and fails `run`
# while $T/fail-run exists.
cat > "$T/bin/docker" <<'FAKE'
#!/bin/bash
echo "$*" >> "$FAKE_DIR/calls"
names="$FAKE_DIR/names"; touch "$names"
case "$1" in
    ps) cat "$names" ;;
    run)
        [[ -e "$FAKE_DIR/fail-run" ]] && exit 125
        shift; printf '%s\n' "$@" > "$FAKE_DIR/last-run"
        while [[ "$1" != --name ]]; do shift; done; echo "$2" >> "$names" ;;
    rename) sed -i "s/^$2\$/$3/" "$names" ;;
    rm) n="${*: -1}"; sed -i "/^${n}\$/d" "$names" ;;
esac
exit 0
FAKE
chmod +x "$T/bin/docker"
export PATH="$T/bin:$PATH" FAKE_DIR="$T" GPU=0
export NETWORK=net NATS_HOST=nats PG_HOST=pg INDEXER_HOST=idx NGINX_CONTAINER=web

fail() { echo "FAIL: $*" >&2; exit 1; }
WS="$HUB/workspaces/alice"

# add-user, with a bare and a targeted data mount.
IMAGE=img:1 "$HUB/scripts/add-user.sh" alice --data "$T/data/set1" --data "$T/refs:/workspace/refs:ro" >/dev/null
cp "$T/last-run" "$T/added"
grep -qx -- "$T/data/set1:/workspace/data/set1" "$T/added" || fail "bare --data not mounted at /workspace/data/<dirname>"
grep -qx -- "$T/refs:/workspace/refs:ro" "$T/added" || fail "targeted --data not mounted"
grep -q '"MEMORY_API_URL": "http://idx:8400"' "$WS/.mcp.json" || fail ".mcp.json does not point at the hub's indexer"

# The user customizes a command; a hook script drifts.
echo "mine" > "$WS/.labweaver/commands/tick.md"
echo "stale" > "$WS/.labweaver/hooks/posttool_jobid.sh"

# recreate, with no hub hosts in the environment: the spec supplies them.
unset NETWORK NATS_HOST PG_HOST INDEXER_HOST NGINX_CONTAINER
"$HUB/scripts/recreate-user.sh" alice >/dev/null
diff "$T/added" "$T/last-run" || fail "recreate's docker run differs from add's"
[[ "$(cat "$WS/.labweaver/commands/tick.md")" == mine ]] || fail "recreate overwrote a user's command"
cmp -s "$WS/.labweaver/hooks/posttool_jobid.sh" "$HUB/skeleton/harness/hooks/posttool_jobid.sh" || fail "recreate left a stale hook"
grep -qx "labweaver-alice" "$T/names" && ! grep -q -- "-old" "$T/names" || fail "old container not removed"

# A skeleton update reaches copies the user has not edited, and only those.
echo "updated" >> "$HUB/skeleton/harness/commands/tick.md"
echo "updated" >> "$HUB/skeleton/harness/commands/memory.md"
"$HUB/scripts/recreate-user.sh" alice >/dev/null
[[ "$(cat "$WS/.labweaver/commands/tick.md")" == mine ]] || fail "a skeleton update overwrote a user's command"
cmp -s "$WS/.labweaver/commands/memory.md" "$HUB/skeleton/harness/commands/memory.md" || fail "a skeleton update missed an unedited command"
cp "$T/last-run" "$T/added"

# A new image sticks for later recreates.
IMAGE=img:2 "$HUB/scripts/recreate-user.sh" alice >/dev/null
"$HUB/scripts/recreate-user.sh" alice >/dev/null
[[ "$(tail -1 "$T/last-run")" == img:2 ]] || fail "image override not kept"
diff <(sed '$d' "$T/added") <(sed '$d' "$T/last-run") || fail "image change altered other args"

# A user with no data mounts recreates with none.
NETWORK=net NATS_HOST=nats PG_HOST=pg INDEXER_HOST=idx NGINX_CONTAINER=web IMAGE=img:1 "$HUB/scripts/add-user.sh" bob >/dev/null
cp "$T/last-run" "$T/bob-added"
"$HUB/scripts/recreate-user.sh" bob >/dev/null
diff "$T/bob-added" "$T/last-run" || fail "recreate without data mounts differs from add"

# A failed start brings the old container back under its own name.
touch "$T/fail-run"
: > "$T/calls"
if "$HUB/scripts/recreate-user.sh" alice >/dev/null 2>&1; then fail "recreate succeeded with a failing run"; fi
grep -qx "labweaver-alice" "$T/names" || fail "old container not restored"
grep -qx "start labweaver-alice" "$T/calls" || fail "old container not restarted"

echo "user-container: ok"
