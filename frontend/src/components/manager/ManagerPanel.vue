<script setup lang="ts">
// Manager view: every container's status, from the reports the adapters
// publish on NATS (adapter/src/fleet-status.ts). Refreshes while open.
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { fleetService, type FleetEntry } from '@/services/fleet'

const REFRESH_MS = 10_000

const entries = ref<FleetEntry[]>([])
const loading = ref(false)
const error = ref('')
const now = ref(Date.now())

async function load() {
  if (loading.value) return
  loading.value = true
  try {
    entries.value = await fleetService.list()
    error.value = ''
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
    now.value = Date.now()
  }
}

let refresh = 0
let clock = 0
onMounted(() => {
  load()
  refresh = window.setInterval(load, REFRESH_MS)
  clock = window.setInterval(() => { now.value = Date.now() }, 1000)
})
onUnmounted(() => {
  window.clearInterval(refresh)
  window.clearInterval(clock)
})

const onlineCount = computed(() => entries.value.filter(e => e.online).length)

function duration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  return h < 48 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d ${h % 24}h`
}

function bytes(n: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++ }
  return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)} ${units[i]}`
}
</script>

<template>
  <div class="panel">
    <header class="panel-header">
      <h3>Containers <span class="count">{{ onlineCount }}/{{ entries.length }} online</span></h3>
      <button class="refresh" @click="load" :disabled="loading">{{ loading ? '…' : 'Refresh' }}</button>
    </header>
    <div v-if="error" class="error">{{ error }}</div>
    <div v-else-if="!entries.length && !loading" class="empty">No containers have reported yet.</div>
    <div v-else class="list">
      <div class="row head">
        <span>User</span><span>Up</span><span>CPU</span><span>Memory</span><span title="Turns running / notebook kernels">Work</span><span>Seen</span>
      </div>
      <div v-for="e in entries" :key="e.username" class="row" :class="{ offline: !e.online }">
        <span class="user">
          <i class="dot" :title="e.online ? 'Online' : 'Offline'" />
          <span class="name">{{ e.username }}</span>
          <span v-if="e.status?.role === 'manager'" class="tag">manager</span>
        </span>
        <template v-if="e.status">
          <span>{{ e.online ? duration(now - e.status.startedAt) : '—' }}</span>
          <span>{{ e.online && e.status.cpuPercent !== null ? `${e.status.cpuPercent}%` : '—' }}</span>
          <span :title="e.status.memoryLimitBytes ? `limit ${bytes(e.status.memoryLimitBytes)}` : 'no limit'">
            {{ e.online ? bytes(e.status.memoryBytes) : '—' }}
          </span>
          <span :title="`${e.status.activeTurns} turns running, ${e.status.kernels} kernels`">
            {{ e.online ? `${e.status.activeTurns} / ${e.status.kernels}` : '—' }}
          </span>
          <span class="seen">{{ duration(now - e.status.reportedAt) }} ago</span>
        </template>
        <template v-else>
          <span class="never">never reported</span>
        </template>
      </div>
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
.count { margin-left: 6px; font-size: var(--text-xs); font-weight: var(--fw-medium); color: var(--text-muted); }
.refresh {
  padding: var(--space-1) var(--space-2); border-radius: var(--radius);
  border: 1px solid var(--border); background: var(--bg-secondary);
  font-size: var(--text-xs); cursor: pointer;
}
.error { padding: var(--space-3) var(--space-4); color: var(--danger); }
.empty { padding: var(--space-4); color: var(--text-muted); font-size: var(--text-sm); }
.list { flex: 1; overflow-y: auto; padding: 4px 0; }
.row {
  display: grid; grid-template-columns: minmax(0, 1.6fr) 0.9fr 0.7fr 0.9fr 0.6fr 0.8fr;
  align-items: center; gap: 6px; height: 28px; padding: 0 var(--space-4);
  font-size: var(--text-xs); font-variant-numeric: tabular-nums; color: var(--text-secondary);
}
.row:not(.head):hover { background: var(--bg-hover); }
.row.head { height: 24px; color: var(--text-muted); font-weight: var(--fw-medium); }
.row.offline { color: var(--text-muted); }
.user { display: flex; align-items: center; gap: 6px; min-width: 0; }
.name { color: var(--text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.offline .name { color: var(--text-muted); }
.dot { flex: none; width: 7px; height: 7px; border-radius: 50%; background: var(--success); }
.offline .dot { background: var(--danger); }
.tag {
  flex: none; padding: 0 5px; border-radius: 4px; font-size: 10px; line-height: 15px;
  background: var(--bg-hover); color: var(--text-muted);
}
.seen { color: var(--text-muted); }
.never { grid-column: 2 / -1; color: var(--text-muted); }
</style>
