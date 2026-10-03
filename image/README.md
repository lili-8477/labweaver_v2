# labweaver image

Per-user devcontainer image. Runs the NATS adapter, which drives DeepSeek Harness
(`dsh --profile acp`, bundled as an adapter dependency) for agent turns.

## Build

From the repo root:

```bash
# 1. Build the adapter bundle first — Dockerfile copies dist/ directly.
cd adapter && npm ci && npm run build && cd ..

# 2. Build the labweaver-memory-mcp bundle — Dockerfile copies dist/ directly.
cd mcp-memory && npm ci && npm run build && cd ..

# 3. Build the image.
docker build -f image/Dockerfile -t labweaver:dev .
```

## Base image

Inherits `pantheon-agents-sc:latest` for the bio stack (Python 3.12 + scanpy +
R 4.5.3 + Seurat/SoupX/scDblFinder via rpy2). We do not invoke any Pantheon
framework code from the base — the adapter is the entrypoint.

## Decoupling from Pantheon

If you want a fully self-contained image (no dependency on
`pantheon-agents-sc:latest`), extract the bio stack into a fresh
`labweaver-base:latest` that mirrors the contents of
`pantheon-hub/images/sc-runtime/`. Copy `requirements-sc.txt` and
`Rpackages-sc.R` into `image/` and make the Dockerfile self-hosting.
This is intentionally deferred — the bio base is stable and rebuilding it
takes ~20 min, so reusing the existing artifact is the pragmatic choice.

## Environment the adapter expects

| var | default | purpose |
|---|---|---|
| `ID_HASH` | required | 12-hex short hash; `service_id = sha256(ID_HASH)` |
| `NATS_SERVERS` | `nats://localhost:4222` | NATS server URL |
| `NATS_USER` | `agent` | NATS auth user |
| `NATS_PASS` | — | NATS auth token (optional) |
| `WORKSPACE_ROOT` | `/workspace` | bind-mounted workspace |
| `DEFAULT_PROJECT` | `/workspace` | cwd for agent turns |
| `HOME` | `/home/node` | where `.claude/` lives |
| `DEEPSEEK_API_KEY` | — | DeepSeek provider; sourced from `$WORKSPACE_ROOT/.env` |
| `OLLAMA_API_KEY` | — | Ollama Cloud provider; sourced from `$WORKSPACE_ROOT/.env` |
| `OLLAMA_BASE_URL` | `https://ollama.com/v1` | Ollama OpenAI-compatible endpoint |
| `OLLAMA_CLOUD_MODELS` | built-in list | comma-separated Ollama Cloud model ids to offer |
| `DSH_HOME` | `/home/node/.dsh` | harness sessions + generated patch; persist it (bind-mounted per user) |
| `DSH_PERMISSION_MODE` | `danger-full-access` | headless tool permissions (equivalent of `bypassPermissions`) |
| `MCP_CONFIG` | `$WORKSPACE_ROOT/.mcp.json` | Claude-style MCP config forwarded to every session |
