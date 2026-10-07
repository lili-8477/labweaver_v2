<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { useChatStore } from '@/stores/chat'
import { natsService } from '@/services/nats'
import { formatTokens, formatDuration } from '@/utils/format'
import type { ChatStats, TokenTotals, SubagentRun } from '@/types'

const POLL_MS = 3000

const chat = useChatStore()
const stats = ref<ChatStats | null>(null)
const loading = ref(false)
const harnessBusy = ref(false)
const now = ref(Date.now())

const live = computed(() => chat.sending || chat.isStreaming)

async function toggleHarness() {
  if (harnessBusy.value) return
  harnessBusy.value = true
  try {
    await natsService.invoke('set_harness_mode', { enabled: !chat.harnessActive })
    await chat.refreshHarnessMode()
  } catch (e) {
    console.error('Failed to toggle harness mode:', e)
  } finally {
    harnessBusy.value = false
  }
}

async function loadStats() {
  const chatId = chat.activeChatId
  if (!chatId) { stats.value = null; return }
  loading.value = true
  try {
    const res = await natsService.invoke('get_chat_stats', { chat_id: chatId }) as
      ({ success: boolean } & ChatStats) | undefined
    if (res?.success && chat.activeChatId === chatId) stats.value = res
  } catch (e) {
    console.warn('Failed to load chat stats:', e)
  } finally {
    loading.value = false
    now.value = Date.now()
  }
}

// Poll while a turn runs, so subagent runs and their tokens show up as they
// happen; refresh once more when it ends to pick up the turn's totals.
let timer: ReturnType<typeof setInterval> | null = null
watch(live, (on) => {
  if (timer) { clearInterval(timer); timer = null }
  if (on) timer = setInterval(loadStats, POLL_MS)
  else loadStats()
}, { immediate: true })
watch(() => chat.activeChatId, () => { stats.value = null; loadStats() })

onMounted(() => {
  chat.refreshHarnessMode()
  loadStats()
})
onUnmounted(() => { if (timer) clearInterval(timer) })

const sum = (t: TokenTotals) => t.input + t.cacheRead + t.cacheWrite + t.output

const subTotals = computed<TokenTotals>(() => {
  const out = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  for (const r of stats.value?.subagents ?? []) {
    out.input += r.tokens.input
    out.output += r.tokens.output
    out.cacheRead += r.tokens.cacheRead
    out.cacheWrite += r.tokens.cacheWrite
  }
  return out
})

const totals = computed(() => {
  const m = stats.value?.main
  if (!m) return null
  const s = subTotals.value
  const all = {
    input: m.input + s.input,
    output: m.output + s.output,
    cacheRead: m.cacheRead + s.cacheRead,
    cacheWrite: m.cacheWrite + s.cacheWrite,
  }
  const total = sum(all)
  const prompt = all.input + all.cacheRead + all.cacheWrite
  return {
    ...all,
    total,
    main: sum(m),
    sub: sum(s),
    mainShare: total ? (sum(m) / total) * 100 : 0,
    cacheHit: prompt ? Math.round((all.cacheRead / prompt) * 100) : 0,
  }
})

const runningCount = computed(() =>
  stats.value?.subagents.filter(r => r.status === 'running').length ?? 0)

// Newest first: the run in flight sits at the top.
const runs = computed(() => [...(stats.value?.subagents ?? [])].reverse())

function runDuration(r: SubagentRun): string {
  const end = r.status === 'running' ? now.value : Date.parse(r.endedAt)
  return formatDuration(end - Date.parse(r.startedAt))
}

function runTime(r: SubagentRun): string {
  return new Date(r.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

const STATUS_LABEL: Record<SubagentRun['status'], string> = {
  running: 'Running', done: 'Done', failed: 'Failed', stopped: 'Stopped',
}
</script>

<template>
  <div class="panel">
    <header class="panel-header">
      <h3>Agents</h3>
      <button class="refresh" :disabled="loading || !chat.activeChatId" @click="loadStats">
        {{ loading ? '…' : 'Refresh' }}
      </button>
    </header>

    <div class="body">
      <!-- Mode -->
      <section class="section">
        <div class="mode-card" :class="{ disabled: !chat.harnessInstalled }">
          <div class="mode-info">
            <span class="mode-name">Self-driving</span>
            <span class="mode-desc">
              <template v-if="!chat.harnessInstalled">Tick harness not installed for this workspace.</template>
              <template v-else-if="chat.harnessActive">Each message runs /tick rounds until progress.md is complete; a reviewer subagent checks each step.</template>
              <template v-else>Off — chat behaves as a normal agent session.</template>
            </span>
          </div>
          <button
            class="btn-toggle"
            :class="{ on: chat.harnessActive }"
            :disabled="!chat.harnessInstalled || harnessBusy"
            :title="chat.harnessActive ? 'Disable self-driving' : 'Enable self-driving'"
            @click="toggleHarness()"
          >
            {{ chat.harnessActive ? 'On' : 'Off' }}
          </button>
        </div>
      </section>

      <div v-if="!chat.activeChatId" class="empty">Select a chat to see its token usage and subagents.</div>

      <template v-else>
        <!-- Tokens -->
        <section class="section">
          <div class="section-title">Tokens <span class="scope">this chat</span></div>
          <div v-if="!totals || totals.total === 0" class="empty">
            {{ stats ? 'No token usage recorded yet.' : 'Loading…' }}
          </div>
          <template v-else>
            <div class="headline">
              <span class="big">{{ formatTokens(totals.total) }}</span>
              <span class="sub">
                {{ stats!.turns }} turn{{ stats!.turns === 1 ? '' : 's' }}
                <template v-if="stats!.lastTurn"> · last {{ formatTokens(sum(stats!.lastTurn)) }}</template>
              </span>
            </div>

            <div class="split-bar" role="img"
              :aria-label="`Main agent ${formatTokens(totals.main)}, subagents ${formatTokens(totals.sub)}`">
              <span class="seg main" :style="{ width: totals.mainShare + '%' }" />
              <span class="seg subs" :style="{ width: 100 - totals.mainShare + '%' }" />
            </div>
            <div class="legend">
              <span><i class="dot main" />Main agent <b>{{ formatTokens(totals.main) }}</b></span>
              <span><i class="dot subs" />Subagents <b>{{ formatTokens(totals.sub) }}</b></span>
            </div>

            <dl class="grid">
              <div><dt>Input</dt><dd>{{ formatTokens(totals.input) }}</dd></div>
              <div><dt>Cache read</dt><dd>{{ formatTokens(totals.cacheRead) }}</dd></div>
              <div><dt>Output</dt><dd>{{ formatTokens(totals.output) }}</dd></div>
              <div><dt>Cache hit</dt><dd>{{ totals.cacheHit }}%</dd></div>
            </dl>
          </template>
        </section>

        <!-- Subagents -->
        <section class="section">
          <div class="section-title">
            Subagents
            <span v-if="stats?.subagents.length" class="scope">
              {{ stats.subagents.length }}<template v-if="runningCount"> · {{ runningCount }} running</template>
            </span>
          </div>
          <div v-if="stats && runs.length === 0" class="empty">
            No subagent runs in this chat. In self-driving mode, each finished step is reviewed by one.
          </div>
          <article v-for="r in runs" :key="r.sessionId" class="run" :class="r.status">
            <div class="run-head">
              <span class="status-dot" :title="STATUS_LABEL[r.status]" />
              <span class="run-name">{{ r.description || 'Subagent' }}</span>
              <span class="run-tokens">{{ formatTokens(sum(r.tokens)) }}</span>
            </div>
            <div class="run-meta">
              <span class="badge">{{ STATUS_LABEL[r.status] }}</span>
              <span>{{ runTime(r) }}</span>
              <span>{{ runDuration(r) }}</span>
              <span>{{ r.toolCalls }} tool call{{ r.toolCalls === 1 ? '' : 's' }}</span>
              <span v-if="r.model" class="mono">{{ r.model }}</span>
            </div>
            <p v-if="r.result" class="run-result" :title="r.result">{{ r.result }}</p>
          </article>
        </section>
      </template>
    </div>
  </div>
</template>

<style scoped>
.panel { display: flex; flex-direction: column; height: 100%; overflow: hidden; }
.panel-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: var(--space-3) var(--space-4); border-bottom: 1px solid var(--border-soft);
}
.panel-header h3 { margin: 0; font-size: var(--text-md); font-weight: var(--fw-semi); }
.refresh {
  padding: var(--space-1) var(--space-2); border-radius: var(--radius);
  border: 1px solid var(--border); background: var(--bg-secondary);
  font-size: var(--text-xs); cursor: pointer;
}
.refresh:disabled { cursor: default; opacity: 0.6; }
.body { flex: 1; overflow-y: auto; }

.section { padding: var(--space-3) var(--space-4); border-bottom: 1px solid var(--border-soft); }
.section-title {
  display: flex; align-items: baseline; gap: var(--space-2);
  margin-bottom: var(--space-2);
  font-size: var(--text-xs); font-weight: var(--fw-semi); color: var(--text-muted);
  text-transform: uppercase; letter-spacing: 0.5px;
}
.scope { text-transform: none; letter-spacing: 0; font-weight: var(--fw-regular); }
.empty { padding: var(--space-2) var(--space-4); color: var(--text-muted); font-size: var(--text-sm); }
.section .empty { padding: var(--space-1) 0; }

/* Mode */
.mode-card {
  display: flex; align-items: center; gap: var(--space-3);
  padding: var(--space-3); border-radius: var(--radius-lg);
  background: var(--bg-primary); border: 1px solid var(--border-soft);
}
.mode-card.disabled { opacity: 0.6; }
.mode-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.mode-name { font-weight: var(--fw-semi); font-size: var(--text-sm); }
.mode-desc { font-size: var(--text-xs); color: var(--text-secondary); line-height: 1.35; }
.btn-toggle {
  min-width: 48px; padding: var(--space-1) var(--space-3);
  border: 1px solid var(--border); border-radius: var(--radius-pill);
  background: transparent; color: var(--text-secondary); font-size: var(--text-xs);
}
.btn-toggle:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); }
.btn-toggle.on { background: var(--accent); border-color: var(--accent); color: #fff; }
.btn-toggle:disabled { cursor: not-allowed; opacity: 0.5; }

/* Tokens */
.headline { display: flex; align-items: baseline; gap: var(--space-2); margin-bottom: var(--space-2); }
.big {
  font-size: var(--text-2xl); font-weight: var(--fw-semi);
  font-variant-numeric: tabular-nums; line-height: 1.1;
}
.sub { font-size: var(--text-xs); color: var(--text-muted); }
.split-bar {
  display: flex; height: 6px; border-radius: var(--radius-pill);
  overflow: hidden; background: var(--bg-tertiary); gap: 2px;
}
.seg { display: block; height: 100%; min-width: 0; transition: width 0.3s ease; }
.seg.main, .dot.main { background: var(--accent); }
.seg.subs, .dot.subs { background: var(--warning); }
.legend {
  display: flex; flex-wrap: wrap; gap: var(--space-1) var(--space-4);
  margin-top: var(--space-2); font-size: var(--text-xs); color: var(--text-secondary);
}
.legend b { color: var(--text-primary); font-weight: var(--fw-medium); font-variant-numeric: tabular-nums; }
.dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; }
.grid {
  display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-2);
  margin: var(--space-3) 0 0;
}
.grid div {
  padding: var(--space-2) var(--space-3); border-radius: var(--radius);
  background: var(--bg-primary); border: 1px solid var(--border-soft);
}
.grid dt { font-size: var(--text-2xs); color: var(--text-muted); }
.grid dd {
  margin: 0; font-size: var(--text-md); font-weight: var(--fw-medium);
  font-variant-numeric: tabular-nums;
}

/* Subagents */
.run {
  --status: var(--text-muted);
  padding: var(--space-2) var(--space-3); margin-bottom: var(--space-2);
  border-radius: var(--radius-lg); background: var(--bg-primary);
  border: 1px solid var(--border-soft); border-left: 3px solid var(--status);
}
.run.running { --status: var(--accent); }
.run.done { --status: var(--success); }
.run.failed { --status: var(--danger); }
.run-head { display: flex; align-items: center; gap: var(--space-2); }
.status-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--status); flex-shrink: 0; }
.run.running .status-dot { animation: pulse 1.2s ease-in-out infinite; }
.run-name {
  flex: 1; min-width: 0; font-size: var(--text-sm); font-weight: var(--fw-medium);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.run-tokens {
  font-size: var(--text-xs); color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
}
.run-meta {
  display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-1) var(--space-3);
  margin-top: var(--space-1); padding-left: calc(8px + var(--space-2));
  font-size: var(--text-xs); color: var(--text-muted);
}
.badge { color: var(--status); font-weight: var(--fw-medium); }
.mono { font-family: var(--font-mono); }
.run-result {
  margin: var(--space-2) 0 0; padding-left: calc(8px + var(--space-2));
  font-size: var(--text-xs); color: var(--text-secondary); line-height: 1.4;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
  word-break: break-word;
}

@keyframes pulse { 50% { opacity: 0.35; } }
@media (prefers-reduced-motion: reduce) {
  .run.running .status-dot { animation: none; }
  .seg { transition: none; }
}
</style>
