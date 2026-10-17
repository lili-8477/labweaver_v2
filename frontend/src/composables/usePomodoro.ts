/**
 * Pomodoro timer: focus → short break, every 4th break is long. The clock
 * counts up from 00:00 to the phase length; phase lengths are user-set.
 *
 * Time is tracked as an absolute `startedAt` timestamp (not an incrementing
 * counter) so it stays correct when the tab is throttled in the
 * background, and survives a reload via localStorage.
 */
import { ref, computed, watch, onUnmounted } from 'vue'

export type PomodoroMode = 'focus' | 'short' | 'long'

export const DEFAULT_MINUTES: Record<PomodoroMode, number> = { focus: 25, short: 5, long: 15 }
export const MODE_LABEL: Record<PomodoroMode, string> = { focus: 'Focus', short: 'Short break', long: 'Long break' }
export const MAX_MINUTES = 180
const LONG_BREAK_EVERY = 4
const STORAGE_KEY = 'labweaver-pomodoro'

interface Saved {
  mode: PomodoroMode
  startedAt: number | null   // set while running (now - elapsed)
  elapsedMs: number          // authoritative while paused
  completed: number          // focus sessions finished
  minutes: Record<PomodoroMode, number>
}

function load(): Saved {
  let raw: Partial<Saved> = {}
  try { raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') } catch { /* ignore */ }
  return {
    mode: raw.mode ?? 'focus',
    startedAt: raw.startedAt ?? null,
    elapsedMs: raw.elapsedMs ?? 0,
    completed: raw.completed ?? 0,
    minutes: { ...DEFAULT_MINUTES, ...raw.minutes },
  }
}

/** Short two-note chime via WebAudio — no asset to ship. */
function chime() {
  try {
    const ctx = new AudioContext()
    ;[660, 880].forEach((freq, i) => {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      const t = ctx.currentTime + i * 0.22
      osc.frequency.value = freq
      gain.gain.setValueAtTime(0.0001, t)
      gain.gain.exponentialRampToValueAtTime(0.25, t + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.6)
      osc.connect(gain).connect(ctx.destination)
      osc.start(t)
      osc.stop(t + 0.65)
    })
    setTimeout(() => ctx.close(), 1500)
  } catch { /* audio unavailable */ }
}

function notify(text: string) {
  if ('Notification' in window && Notification.permission === 'granted') {
    new Notification('LabWeaver', { body: text, icon: '/favicon.svg' })
  }
}

export function usePomodoro() {
  const state = ref<Saved>(load())
  const now = ref(Date.now())

  const running = computed(() => state.value.startedAt !== null)
  const totalMs = computed(() => state.value.minutes[state.value.mode] * 60_000)
  const elapsedMs = computed(() =>
    Math.min(totalMs.value, running.value ? now.value - state.value.startedAt! : state.value.elapsedMs),
  )
  const progress = computed(() => elapsedMs.value / totalMs.value)
  const display = computed(() => {
    const s = Math.floor(elapsedMs.value / 1000)
    return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
  })
  /** Position within the current 4-session cycle, for the progress dots. */
  const cycleDone = computed(() => state.value.completed % LONG_BREAK_EVERY)

  watch(state, (v) => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(v)) } catch { /* ignore */ }
  }, { deep: true })

  function setMode(mode: PomodoroMode) {
    state.value = { ...state.value, mode, startedAt: null, elapsedMs: 0 }
  }

  /** Change a phase's length; a running phase keeps its elapsed time. */
  function setMinutes(mode: PomodoroMode, minutes: number) {
    if (!Number.isFinite(minutes)) return
    const m = Math.min(MAX_MINUTES, Math.max(1, Math.round(minutes)))
    state.value = { ...state.value, minutes: { ...state.value.minutes, [mode]: m } }
  }

  function start() {
    if (running.value) return
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission()
    }
    state.value = { ...state.value, startedAt: Date.now() - state.value.elapsedMs }
  }

  function pause() {
    if (!running.value) return
    state.value = { ...state.value, startedAt: null, elapsedMs: elapsedMs.value }
  }

  const toggle = () => (running.value ? pause() : start())
  const reset = () => setMode(state.value.mode)

  /** Move to the next phase (on completion or when the user skips). */
  function advance() {
    if (state.value.mode === 'focus') {
      const completed = state.value.completed + 1
      state.value = { ...state.value, completed }
      setMode(completed % LONG_BREAK_EVERY === 0 ? 'long' : 'short')
    } else {
      setMode('focus')
    }
  }

  function finish() {
    const wasFocus = state.value.mode === 'focus'
    chime()
    notify(wasFocus ? 'Focus session done — take a break.' : 'Break over — back to it.')
    advance()
  }

  // Tick only drives the display; completion is derived from startedAt.
  const timer = window.setInterval(() => {
    now.value = Date.now()
    if (running.value && now.value - state.value.startedAt! >= totalMs.value) finish()
  }, 250)
  onUnmounted(() => window.clearInterval(timer))

  return {
    mode: computed(() => state.value.mode),
    minutes: computed(() => state.value.minutes),
    running, elapsedMs, progress, display, cycleDone,
    setMode, setMinutes, toggle, reset, skip: advance,
  }
}
