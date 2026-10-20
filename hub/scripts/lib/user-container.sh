# User container (GLOSSARY.md): one user's devcontainer, provisioned the same
# way whether it is being added or recreated. Sourced by add-user.sh and
# recreate-user.sh; expects HUB_DIR to be set.
#
# The container spec — image, hub hosts, data mounts — is saved in the
# user's workspace (container.env, outside every bind mount), so a recreate
# rebuilds exactly the container add-user made:
#
#   spec_save <user>             write the spec from the variables below
#   spec_load <user>             read it back (IMAGE from the environment wins)
#   prepare_workspace <user>     host-side files the container mounts; idempotent
#   run_user_container <user>    docker run from the spec
#
# Spec variables: IMAGE NETWORK NATS_HOST PG_HOST INDEXER_HOST NGINX_CONTAINER
# and the array DATA_MOUNTS ("host:target[:ro]", already resolved).

WORKSPACES_DIR="${HUB_DIR}/workspaces"
SHARED_DIR="${WORKSPACES_DIR}/shared"
SPEC_KEYS=(IMAGE NETWORK NATS_HOST PG_HOST INDEXER_HOST NGINX_CONTAINER)

spec_file() { echo "${WORKSPACES_DIR}/$1/container.env"; }

spec_save() {
    local k f
    f="$(spec_file "$1")"
    {
        echo "# User container spec — read by recreate-user.sh. Edit to move hubs or add data mounts."
        for k in "${SPEC_KEYS[@]}"; do printf '%s=%q\n' "$k" "${!k}"; done
        printf 'DATA_MOUNTS=('
        for k in "${DATA_MOUNTS[@]+"${DATA_MOUNTS[@]}"}"; do printf ' %q' "$k"; done
        printf ' )\n'
    } > "$f"
}

spec_load() {
    local f image="${IMAGE:-}"
    f="$(spec_file "$1")"
    [[ -f "$f" ]] || { echo "No container spec at ${f}; write one with the user's hub hosts (see add-user.sh)." >&2; return 1; }
    DATA_MOUNTS=()
    # shellcheck source=/dev/null
    . "$f"
    [[ -n "$image" ]] && IMAGE="$image"
    return 0
}

# --data PATH[:MOUNT[:ro]] → "host:target[:ro]"; a bare path mounts at /workspace/data/<dirname>.
resolve_data_mount() {
    if [[ "$1" == *":"* ]]; then echo "$1"; else echo "$1:/workspace/data/$(basename "$1")"; fi
}

# The commented CHPC bridge stanza, or an active one for UNID $2.
write_ssh_config() {
    local cfg="$1/.ssh/config" unid="${2:-}"
    if [[ -n "$unid" ]]; then
        cat > "$cfg" <<EOF
# CHPC bridge — auto-populated by add-user.sh.
# To change the UNID, edit the User line below.
# Reference: /workspace/shared/skills/chpc-bridge/SKILL.md

Host chpc-login
    HostName notchpeak.chpc.utah.edu
    User ${unid}
    ControlMaster auto
    ControlPath ~/.ssh/cm-%r@%h:%p
    ControlPersist 8h
    ServerAliveInterval 60
    ServerAliveCountMax 3
    StrictHostKeyChecking accept-new
    UserKnownHostsFile ~/.ssh/known_hosts
EOF
        # Pre-seed notchpeak's host keys so the first connection doesn't prompt.
        if command -v ssh-keyscan >/dev/null 2>&1; then
            if ssh-keyscan -H notchpeak.chpc.utah.edu > "$1/.ssh/known_hosts" 2>/dev/null \
                && [[ -s "$1/.ssh/known_hosts" ]]; then
                chmod 600 "$1/.ssh/known_hosts"
                echo "  pre-seeded notchpeak.chpc.utah.edu host keys"
            else
                rm -f "$1/.ssh/known_hosts"
                echo "  warn: ssh-keyscan against notchpeak failed (no campus network / VPN?); accept-new will fill known_hosts on first connect"
            fi
        fi
    else
        cat > "$cfg" <<'SSHCFG'
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
    chmod 600 "$cfg"
}

# Everything on the host the container bind-mounts, created if missing and
# refreshed where the hub owns it. First-time-only inputs: CHPC_UNID,
# API_KEY and OLLAMA_API_KEY (used only when the file they seed is absent).
prepare_workspace() {
    local user="$1" ws="${WORKSPACES_DIR}/$1"
    local skel="${HUB_DIR}/skeleton/harness" spec

    mkdir -p "${ws}/.labweaver/skills" "${ws}/.labweaver/agents" "${ws}/.labweaver/projects" \
             "${ws}/.labweaver/commands" "${ws}/.labweaver/hooks" \
             "${ws}/.dsh" "${ws}/local_projects" "${ws}/.latch" "${ws}/.ssh" \
             "${SHARED_DIR}/reference" "${SHARED_DIR}/projects" "${SHARED_DIR}/skills"
    # .latch holds the Latch CLI token; .ssh is the CHPC bridge's home (config,
    # known_hosts, multiplex socket). Both credentials, both must be 700.
    chmod 700 "${ws}/.latch" "${ws}/.ssh"
    [[ -f "${ws}/.ssh/config" ]] || write_ssh_config "$ws" "${CHPC_UNID:-}"
    for spec in "${DATA_MOUNTS[@]+"${DATA_MOUNTS[@]}"}"; do mkdir -p "${spec%%:*}"; done

    [[ -f "${ws}/.labweaver/settings.json" ]] || cat > "${ws}/.labweaver/settings.json" <<'JSON'
{
  "$schema": "https://claude.ai/schemas/settings.json",
  "model": "deepseek-official/deepseek-v4-pro"
}
JSON

    # The self-driving tick harness (dormant unless a chat is switched to
    # Auto). Commands/agents: cp -n, so user customizations survive. Hooks:
    # cp -f — harness-managed code that must track the skeleton.
    if [[ -d "$skel" ]]; then
        cp -n "${skel}/commands/"*.md "${ws}/.labweaver/commands/" 2>/dev/null || true
        cp -n "${skel}/agents/"tick-*.md "${ws}/.labweaver/agents/" 2>/dev/null || true
        cp -f "${skel}/hooks/"*.sh "${ws}/.labweaver/hooks/" 2>/dev/null || true
        chmod +x "${ws}/.labweaver/hooks/"*.sh 2>/dev/null || true
        # In place, preserving the inode: settings.json is bind-mounted.
        python3 "${HUB_DIR}/scripts/merge-harness-hooks.py" "${ws}/.labweaver/settings.json"
    fi

    # A slim CLAUDE.md that @-imports the shared base, mounted live at
    # /workspace/.labweaver/shared.md; user overrides go below the import.
    [[ -f "${ws}/CLAUDE.md" ]] || printf '@/workspace/.labweaver/shared.md\n\n# %s — local overrides\n\n' "$user" > "${ws}/CLAUDE.md"

    if [[ ! -f "${ws}/.env" ]]; then
        {
            echo "# labweaver — user: ${user}"
            if [[ -n "${API_KEY:-}" ]]; then echo "DEEPSEEK_API_KEY=${API_KEY}"; else echo "#DEEPSEEK_API_KEY=sk-your-key-here"; fi
            if [[ -n "${OLLAMA_API_KEY:-}" ]]; then echo "OLLAMA_API_KEY=${OLLAMA_API_KEY}"; else echo "#OLLAMA_API_KEY=your-ollama-cloud-key"; fi
        } > "${ws}/.env"
        chmod 600 "${ws}/.env"
    fi

    # The agent's labweaver-memory MCP server, pointed at this hub's indexer.
    python3 "${HUB_DIR}/scripts/merge-mcp-config.py" "${ws}/.mcp.json" "$user" "http://${INDEXER_HOST}:8400"
}

# docker run the user's container from the spec. Needs SERVICE_ID and
# POSTGRES_PASSWORD. GPU=0 disables GPU passthrough.
run_user_container() {
    local user="$1" ws="${WORKSPACES_DIR}/$1" container="labweaver-$1"
    local mounts=(
        # Same path inside and out, so nginx's /download/ maps UI paths 1:1.
        -v "${ws}/local_projects:/workspace/local_projects"
        # The labweaver folder, whole; ~/.labweaver links here (entrypoint.sh)
        # and the indexer watches its transcripts.
        -v "${ws}/.labweaver:/workspace/.labweaver"
        -v "${ws}/.env:/workspace/.env:ro"
        -v "${ws}/CLAUDE.md:/workspace/CLAUDE.md:ro"
        # Single-file mounts keep the inode; host edits must be in place.
        -v "${ws}/.mcp.json:/workspace/.mcp.json:ro"
        -v "${SHARED_DIR}/CLAUDE.md:/workspace/.labweaver/shared.md:ro"
        # DeepSeek Harness state (session logs for resume, generated patch).
        -v "${ws}/.dsh:/home/node/.dsh"
        -v "${ws}/.latch:/home/node/.latch"
        -v "${ws}/.ssh:/home/node/.ssh"
        -v "${SHARED_DIR}/reference:/workspace/shared/reference:ro"
        -v "${SHARED_DIR}/projects:/workspace/shared/projects"
        # Org skills, after personal skills so those win on a name clash.
        -v "${SHARED_DIR}/skills:/workspace/shared/skills:ro"
    )
    local spec
    for spec in "${DATA_MOUNTS[@]+"${DATA_MOUNTS[@]}"}"; do mounts+=(-v "$spec"); done

    # --gpus all fails hard without nvidia-container-toolkit or a loaded
    # driver, so detect both.
    local gpu=()
    if [[ "${GPU:-auto}" != "0" ]] && command -v nvidia-ctk >/dev/null 2>&1 && nvidia-smi -L >/dev/null 2>&1; then
        gpu=(--gpus all)
        echo "  [gpu] --gpus all (detected nvidia-container-toolkit and driver)"
    fi

    docker run -d \
        --name "$container" \
        --network "$NETWORK" \
        --restart unless-stopped \
        "${gpu[@]+"${gpu[@]}"}" \
        -e "SERVICE_ID=${SERVICE_ID}" \
        -e "NATS_SERVERS=nats://${NATS_HOST}:4222" \
        -e "NATS_USER=agent" \
        -e "WORKSPACE_ROOT=/workspace" \
        -e "DEFAULT_PROJECT=/workspace" \
        -e "PG_URL=postgres://labweaver:${POSTGRES_PASSWORD}@${PG_HOST}:5432/labweaver" \
        -e "USERNAME=${user}" \
        -e "HOME=/home/node" \
        -e "MEMORY_API_URL=http://${INDEXER_HOST}:8400" \
        -e "MEMORY_ENABLED=1" \
        "${mounts[@]}" \
        -w /workspace \
        "$IMAGE" >/dev/null || return 1

    sleep 2
    if ! docker ps --format '{{.Names}}' | grep -q "^${container}$"; then
        echo "Error: ${container} failed to start. Logs:" >&2
        docker logs "$container" 2>&1 | tail -30 >&2
        return 1
    fi
}
