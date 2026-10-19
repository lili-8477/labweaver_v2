<script setup lang="ts">
import { ref, computed } from 'vue'
import type { ToolItem } from '@/types'

const props = defineProps<{
  tools: ToolItem[]
  /** The turn is still running, so unfinished tools are running, not cut off. */
  live?: boolean
}>()

const collapsed = ref(true)
const expandedSteps = ref<Set<string>>(new Set())

type Status = 'running' | 'completed' | 'failed' | 'stopped'

const steps = computed(() => props.tools.map(t => ({
  id: t.id,
  name: t.name,
  status: (t.endedAt ? (t.isError ? 'failed' : 'completed') : props.live ? 'running' : 'stopped') as Status,
  duration: t.endedAt ? (Date.parse(t.endedAt) - Date.parse(t.startedAt)) / 1000 : undefined,
  input: formatInput(t.input),
  output: t.output,
})))

const summary = computed(() => {
  const count = (st: Status) => steps.value.filter(s => s.status === st).length
  const n = steps.value.length
  const parts = [`${n} tool${n > 1 ? 's' : ''}`]
  if (count('running')) parts.push(`${count('running')} running`)
  if (count('failed')) parts.push(`${count('failed')} failed`)
  if (count('stopped')) parts.push(`${count('stopped')} stopped`)
  return parts.join(', ')
})

const totalDuration = computed(() => {
  const durations = steps.value.filter(s => s.duration != null).map(s => s.duration!)
  return durations.length ? durations.reduce((a, b) => a + b, 0) : null
})

function formatInput(input: unknown): string {
  if (input == null || (typeof input === 'object' && Object.keys(input as object).length === 0)) return ''
  try { return JSON.stringify(input, null, 2) } catch { return String(input) }
}

function toggleStep(id: string) {
  if (expandedSteps.value.has(id)) {
    expandedSteps.value.delete(id)
  } else {
    expandedSteps.value.add(id)
  }
  expandedSteps.value = new Set(expandedSteps.value)  // trigger reactivity
}

function formatDuration(seconds: number | undefined): string {
  if (seconds == null) return ''
  if (seconds < 0.01) return '<0.01s'
  if (seconds < 1) return `${(seconds * 1000).toFixed(0)}ms`
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const mins = Math.floor(seconds / 60)
  const secs = seconds % 60
  return `${mins}m ${secs.toFixed(0)}s`
}

const ICONS: Record<Status, string> = {
  running: '\u25CB',    // ○
  failed: '\u2717',     // ✗
  stopped: '\u2013',    // –
  completed: '\u2713',  // ✓
}
</script>

<template>
  <div v-if="steps.length" class="execution-timeline" :class="{ live }">
    <!-- Collapse header -->
    <div class="timeline-header" @click="collapsed = !collapsed">
      <span class="toggle-icon">{{ collapsed ? '\u25B6' : '\u25BC' }}</span>
      <span class="timeline-icon">⚙</span>
      <span class="timeline-summary">{{ summary }}</span>
      <span v-if="totalDuration != null" class="timeline-duration">
        {{ formatDuration(totalDuration) }}
      </span>
      <span v-if="live" class="live-badge">LIVE</span>
    </div>

    <!-- Steps list -->
    <div v-if="!collapsed" class="timeline-steps">
      <div class="timeline-line"></div>

      <div
        v-for="step in steps"
        :key="step.id"
        class="timeline-step"
        :class="step.status"
      >
        <!-- Step dot & connector -->
        <div class="step-dot" :class="step.status">
          <span>{{ ICONS[step.status] }}</span>
        </div>

        <!-- Step content -->
        <div class="step-body">
          <div class="step-row" @click="toggleStep(step.id)">
            <span class="step-name">{{ step.name }}</span>
            <span v-if="step.duration != null" class="step-duration">
              {{ formatDuration(step.duration) }}
            </span>
            <span class="step-status-badge" :class="step.status">
              {{ step.status }}
            </span>
            <span v-if="step.input || step.output" class="expand-hint">
              {{ expandedSteps.has(step.id) ? '\u25BC' : '\u25B6' }}
            </span>
          </div>

          <!-- Expanded detail -->
          <div v-if="expandedSteps.has(step.id)" class="step-detail">
            <!-- Input -->
            <div v-if="step.input" class="detail-section">
              <div class="detail-label">Input</div>
              <pre class="detail-content">{{ step.input }}</pre>
            </div>
            <!-- Output -->
            <div v-if="step.output" class="detail-section">
              <div class="detail-label">Output</div>
              <pre class="detail-content" :class="{ error: step.status === 'failed' }">{{ step.output }}</pre>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* A slim 24px row of muted text, no box (DSH's tool-row style). */
.execution-timeline { margin: 2px 0 6px; }

.timeline-header {
  display: inline-flex; align-items: center; gap: 6px;
  height: 24px; cursor: pointer;
  font-size: 13px; color: var(--text-muted);
  transition: color 0.1s;
}
.timeline-header:hover { color: var(--text-secondary); }
.toggle-icon { font-size: 0.7em; width: 10px; }
.timeline-icon { font-size: 0.9em; }
.timeline-summary { flex: 1; }
.timeline-duration {
  font-family: var(--font-mono); font-size: 0.9em; color: var(--text-muted);
}
.live-badge {
  font-size: 0.65em; font-weight: 700; letter-spacing: 0.5px;
  padding: 1px 5px; border-radius: 3px;
  background: var(--accent); color: var(--on-accent);
  animation: pulse-badge 2s infinite;
}
@keyframes pulse-badge {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.6; }
}

.timeline-steps {
  position: relative; padding: 2px 0 4px;
}
.timeline-line {
  position: absolute; left: 8px; top: 0; bottom: 4px;
  width: 1px; background: var(--border);
}

.timeline-step {
  display: flex; gap: 10px; position: relative;
  margin-bottom: 2px;
}

.step-dot {
  width: 16px; height: 16px; border-radius: 50%; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
  font-size: 0.6em; z-index: 1; margin-top: 4px;
  background: var(--bg-primary); border: 2px solid var(--border);
}
.step-dot.completed { border-color: var(--success); color: var(--success); }
.step-dot.running {
  border-color: var(--accent); color: var(--accent);
  animation: spin-dot 1.5s linear infinite;
}
.step-dot.failed { border-color: var(--danger); color: var(--danger); }
.step-dot.stopped { border-color: var(--border); color: var(--text-muted); }
@keyframes spin-dot {
  0% { border-color: var(--accent); }
  50% { border-color: var(--accent-hover); }
  100% { border-color: var(--accent); }
}

.step-body { flex: 1; min-width: 0; }

.step-row {
  display: flex; align-items: center; gap: 6px;
  height: 24px; padding: 0 6px; border-radius: 4px; cursor: pointer;
  font-size: 13px; transition: background 0.1s;
}
.step-row:hover { background: var(--bg-tertiary); }

.step-name {
  font-family: var(--font-mono); font-weight: 500;
  color: var(--text-secondary); white-space: nowrap;
}
.step-duration {
  font-family: var(--font-mono); font-size: 0.9em;
  color: var(--text-muted); margin-left: auto; white-space: nowrap;
}

.step-status-badge {
  font-size: 0.75em; padding: 0 6px; border-radius: 8px;
  white-space: nowrap;
}
.step-status-badge.completed { color: var(--success); background: color-mix(in srgb, var(--success) 12%, transparent); }
.step-status-badge.running { color: var(--accent); background: color-mix(in srgb, var(--accent) 12%, transparent); }
.step-status-badge.failed { color: var(--danger); background: color-mix(in srgb, var(--danger) 12%, transparent); }
.step-status-badge.stopped { color: var(--text-muted); background: var(--bg-tertiary); }

.expand-hint {
  font-size: 0.6em; color: var(--text-muted); width: 10px;
}

.step-detail {
  padding: 4px 6px 6px 6px;
}
.detail-section { margin-bottom: 6px; }
.detail-label {
  font-size: 0.75em; font-weight: 600; color: var(--text-muted);
  text-transform: uppercase; letter-spacing: 0.3px; margin-bottom: 2px;
}
.detail-content {
  margin: 0; padding: 6px 8px; font-family: var(--font-mono);
  font-size: 0.8em; background: var(--code-bg); border: 1px solid var(--border);
  border-radius: 4px; white-space: pre-wrap; word-break: break-all;
  max-height: 150px; overflow-y: auto; color: var(--text-secondary);
}
.detail-content.error { color: var(--danger); }
</style>
