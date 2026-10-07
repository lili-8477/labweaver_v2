<script setup lang="ts">
/**
 * Floating focus window: pomodoro timer + background music.
 * Collapses to a draggable pill; position and open state persist.
 */
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { usePomodoro, MODE_LABEL, type PomodoroMode } from '@/composables/usePomodoro'
import MusicPlayer from '@/components/focus/MusicPlayer.vue'

const timer = usePomodoro()
const music = ref<InstanceType<typeof MusicPlayer> | null>(null)

const STORAGE_KEY = 'labweaver-focus-dock'
const MARGIN = 8
const saved = (() => {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') } catch { return {} }
})() as { open?: boolean; right?: number; bottom?: number }

const open = ref(saved.open ?? false)
// Anchored to the bottom-right corner so it stays put when the window resizes.
const pos = ref({ right: saved.right ?? 20, bottom: saved.bottom ?? 20 })
const dock = ref<HTMLElement | null>(null)

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ open: open.value, ...pos.value }))
  } catch { /* ignore */ }
}
watch(open, persist)

function clamp() {
  const el = dock.value
  if (!el) return
  const { width, height } = el.getBoundingClientRect()
  pos.value = {
    right: Math.min(Math.max(MARGIN, pos.value.right), window.innerWidth - width - MARGIN),
    bottom: Math.min(Math.max(MARGIN, pos.value.bottom), window.innerHeight - height - MARGIN),
  }
}
// Re-clamp after open/close changes the size.
watch(open, () => requestAnimationFrame(clamp))

// ── Drag (anywhere that isn't a control) ──────────────────────────
let drag: { x: number; y: number; right: number; bottom: number } | null = null

function onPointerDown(e: PointerEvent) {
  if (e.button !== 0 || (e.target as Element).closest('button, input, a, iframe, label')) return
  drag = { x: e.clientX, y: e.clientY, ...pos.value }
  ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
}
function onPointerMove(e: PointerEvent) {
  if (!drag) return
  pos.value = { right: drag.right - (e.clientX - drag.x), bottom: drag.bottom - (e.clientY - drag.y) }
  clamp()
}
function onPointerUp() {
  if (!drag) return
  drag = null
  persist()
}

onMounted(() => {
  clamp()
  window.addEventListener('resize', clamp)
})
onUnmounted(() => {
  window.removeEventListener('resize', clamp)
  document.title = 'LabWeaver'
})

// Countdown in the browser tab while running.
watch([timer.display, timer.running, timer.mode], ([display, running, mode]) => {
  document.title = running ? `${display} · ${MODE_LABEL[mode]} — LabWeaver` : 'LabWeaver'
}, { immediate: true })

const MODES: PomodoroMode[] = ['focus', 'short', 'long']
const RING_R = 54
const RING_C = 2 * Math.PI * RING_R
const ringOffset = computed(() => RING_C * (1 - timer.progress.value))
</script>

<template>
  <div
    ref="dock"
    class="dock"
    :class="[open ? 'is-open' : 'is-pill', `mode-${timer.mode.value}`]"
    :style="{ right: pos.right + 'px', bottom: pos.bottom + 'px' }"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerUp"
  >
    <!-- Collapsed pill -->
    <div v-if="!open" class="pill glass">
      <span class="mode-dot" :title="MODE_LABEL[timer.mode.value]" />
      <span class="pill-time">{{ timer.display.value }}</span>
      <button class="icon-btn" @click="timer.toggle" :aria-label="timer.running.value ? 'Pause timer' : 'Start timer'">
        <svg v-if="timer.running.value" viewBox="0 0 16 16"><rect x="4" y="3" width="3" height="10" rx="1" /><rect x="9" y="3" width="3" height="10" rx="1" /></svg>
        <svg v-else viewBox="0 0 16 16"><path d="M5 3.2v9.6a.6.6 0 0 0 .9.5l7.6-4.8a.6.6 0 0 0 0-1L5.9 2.7a.6.6 0 0 0-.9.5Z" /></svg>
      </button>
      <button
        class="icon-btn"
        :class="{ lit: music?.playing }"
        @click="music?.toggle()"
        :aria-label="music?.playing ? 'Pause music' : 'Play music'"
      >
        <svg viewBox="0 0 16 16"><path d="M6 12.5a2 2 0 1 1-1-1.73V3.6a.6.6 0 0 1 .45-.58l6-1.5a.6.6 0 0 1 .75.58V10.5a2 2 0 1 1-1-1.73V4.9L6 6.1Z" /></svg>
      </button>
      <button class="icon-btn" @click="open = true" aria-label="Open focus window">
        <svg viewBox="0 0 16 16"><path d="M4 10l4-4 4 4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" /></svg>
      </button>
    </div>

    <!-- Expanded window. Stays mounted while collapsed (parked off-screen)
         so the music iframe keeps playing. -->
    <section class="panel glass" :class="{ parked: !open }" aria-label="Focus timer and music">
      <header class="panel-head">
        <span class="grip" aria-hidden="true" />
        <span class="panel-title">Focus</span>
        <button class="icon-btn" @click="open = false" aria-label="Collapse focus window">
          <svg viewBox="0 0 16 16"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" /></svg>
        </button>
      </header>

      <div class="modes" role="tablist">
        <button
          v-for="m in MODES"
          :key="m"
          role="tab"
          :aria-selected="timer.mode.value === m"
          :class="{ active: timer.mode.value === m }"
          @click="timer.setMode(m)"
        >{{ MODE_LABEL[m] }}</button>
      </div>

      <div class="dial">
        <svg viewBox="0 0 128 128" aria-hidden="true">
          <circle class="track" cx="64" cy="64" :r="RING_R" />
          <circle
            class="arc"
            cx="64" cy="64" :r="RING_R"
            :stroke-dasharray="RING_C"
            :stroke-dashoffset="ringOffset"
          />
        </svg>
        <div class="dial-text">
          <span class="time" role="timer">{{ timer.display.value }}</span>
          <span class="cycle" :title="`${timer.cycleDone.value} of 4 focus sessions this cycle`">
            <i v-for="n in 4" :key="n" :class="{ done: n <= timer.cycleDone.value }" />
          </span>
        </div>
      </div>

      <div class="controls">
        <button class="ctl" @click="timer.reset" aria-label="Reset" title="Reset">
          <svg viewBox="0 0 16 16"><path d="M3 8a5 5 0 1 0 1.5-3.55M3 2.5v2.5h2.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" /></svg>
        </button>
        <button class="ctl primary" @click="timer.toggle">
          {{ timer.running.value ? 'Pause' : 'Start' }}
        </button>
        <button class="ctl" @click="timer.skip" aria-label="Skip to next" title="Skip to next">
          <svg viewBox="0 0 16 16"><path d="M3.5 3.5v9l6.5-4.5ZM12 3.5v9" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" /></svg>
        </button>
      </div>

      <hr />

      <MusicPlayer ref="music" />
    </section>
  </div>
</template>

<style scoped>
.dock {
  position: fixed;
  z-index: 40;            /* above panes, below modals (100+) */
  touch-action: none;
  user-select: none;
  --mode: var(--accent);
}
.dock.mode-short { --mode: var(--success); }
.dock.mode-long  { --mode: var(--info); }
.dock.is-pill { cursor: grab; }

/* ── Pill ─────────────────────────────────────────────────────── */
.pill {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 5px 6px 5px 14px;
  border-radius: var(--radius-pill);
  box-shadow: var(--shadow-lg);
}
.mode-dot {
  width: 8px; height: 8px; border-radius: 50%;
  background: var(--mode);
  box-shadow: 0 0 10px var(--mode);
  margin-right: 8px;
}
.pill-time {
  font-family: var(--font-mono);
  font-size: var(--text-md);
  font-variant-numeric: tabular-nums;
  margin-right: 6px;
}

.icon-btn {
  width: 28px; height: 28px;
  display: grid; place-items: center;
  border: none; border-radius: 50%;
  background: transparent;
  color: var(--text-secondary);
  transition: background 0.12s, color 0.12s;
}
.icon-btn:hover { background: var(--bg-hover); color: var(--text-primary); }
.icon-btn.lit { color: var(--accent); }
.icon-btn svg { width: 14px; height: 14px; fill: currentColor; }

/* ── Panel ────────────────────────────────────────────────────── */
.panel {
  width: 300px;
  padding: var(--space-3) var(--space-4) var(--space-4);
  border-radius: 22px;
  box-shadow: var(--shadow-lg);
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  user-select: auto;
}
.panel.parked {
  position: fixed;
  left: -10000px;
  top: 0;
  visibility: hidden;     /* out of the a11y tree; iframe keeps playing */
}
.panel-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  cursor: grab;
  user-select: none;
}
.grip {
  width: 18px; height: 10px;
  background-image: radial-gradient(circle, var(--text-muted) 1.2px, transparent 1.4px);
  background-size: 6px 5px;
  opacity: 0.7;
}
.panel-title {
  flex: 1;
  font-family: var(--font-display);
  font-weight: var(--fw-semi);
  font-size: var(--text-md);
}

.modes {
  display: flex;
  padding: 3px;
  border-radius: var(--radius-pill);
  background: var(--bg-primary);
  border: 1px solid var(--border-soft);
}
.modes button {
  flex: 1;
  padding: 4px 0;
  border: none;
  border-radius: var(--radius-pill);
  background: transparent;
  color: var(--text-muted);
  font-size: var(--text-xs);
  font-weight: var(--fw-medium);
  transition: background 0.15s, color 0.15s;
}
.modes button:hover { color: var(--text-primary); }
.modes button.active {
  background: var(--bg-hover);
  color: var(--text-primary);
  box-shadow: var(--glass-rim);
}

.dial { position: relative; width: 168px; height: 168px; margin: 0 auto; }
.dial svg { width: 100%; height: 100%; transform: rotate(-90deg); }
.dial circle { fill: none; stroke-width: 6; }
.dial .track { stroke: var(--border-soft); }
.dial .arc {
  stroke: var(--mode);
  stroke-linecap: round;
  filter: drop-shadow(0 0 6px color-mix(in oklch, var(--mode) 60%, transparent));
  transition: stroke-dashoffset 0.3s linear, stroke 0.3s;
}
.dial-text {
  position: absolute; inset: 0;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: var(--space-2);
}
.time {
  font-family: var(--font-display);
  font-size: 2.6rem;
  font-weight: var(--fw-medium);
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.02em;
  line-height: 1;
}
.cycle { display: flex; gap: 5px; }
.cycle i { width: 6px; height: 6px; border-radius: 50%; background: var(--border); }
.cycle i.done { background: var(--mode); }

.controls { display: flex; align-items: center; justify-content: center; gap: var(--space-3); }
.ctl {
  height: 36px; min-width: 36px;
  display: grid; place-items: center;
  border-radius: var(--radius-pill);
  border: 1px solid var(--border);
  background: var(--bg-tertiary);
  color: var(--text-secondary);
  transition: background 0.12s, color 0.12s, transform 0.15s var(--ease-out-quart);
}
.ctl:hover { background: var(--bg-hover); color: var(--text-primary); }
.ctl:active { transform: scale(0.95); }
.ctl svg { width: 15px; height: 15px; }
.ctl.primary {
  min-width: 108px;
  padding: 0 var(--space-5);
  background: var(--mode);
  border-color: transparent;
  color: oklch(0.18 0.01 135);
  font-weight: var(--fw-semi);
  box-shadow: 0 4px 16px color-mix(in oklch, var(--mode) 35%, transparent), inset 0 1px 0 oklch(1 0 0 / 0.35);
}
.ctl.primary:hover { filter: brightness(1.08); color: oklch(0.18 0.01 135); }

hr { border: none; border-top: 1px solid var(--border-soft); margin: 0 calc(-1 * var(--space-4)); }
</style>
