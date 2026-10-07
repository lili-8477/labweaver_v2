/**
 * Pomodoro timer: 25 min focus → 5 min break, every 4th break is 15 min.
 *
 * Time is tracked as an absolute `endsAt` timestamp (not a decrementing
 * counter) so it stays correct when the tab is throttled in the
 * background, and survives a reload via localStorage.
 */
import { ref, computed, watch, onUnmounted } from 'vue'

export type PomodoroMode = 'focus' | 'short' | 'long'

export const MODE_MINUTES: Record<PomodoroMode, number> = { focus: 25, short: 5, long: 15 }
export const MODE_LABEL: Record<PomodoroMode, string> = { focus: 'Focus', short: 'Short break', long: 'Long break' }
const LONG_BREAK_EVERY = 4
const STORAGE_KEY = 'labweaver-pomodoro'

interface Saved {
  mode: PomodoroMode
  endsAt: number | null      // set while running
  remainingMs: number        // authoritative while paused
  completed: number          // focus sessions finished
}

function load(): Saved {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return JSON.parse(raw)
  } catch { /* ignore */ }
  return { mode: 'focus', endsAt: null, remainingMs: MODE_MINUTES.focus * 60_000, completed: 0 }
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

  const running = computed(() => state.value.endsAt !== null)
  const remainingMs = computed(() =>
    running.value ? Math.max(0, state.value.endsAt! - now.value) : state.value.remainingMs,
  )
  const totalMs = computed(() => MODE_MINUTES[state.value.mode] * 60_000)
  const progress = computed(() => 1 - remainingMs.value / totalMs.value)
  const display = computed(() => {
    const s = Math.ceil(remainingMs.value / 1000)
    return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
  })
  /** Position within the current 4-session cycle, for the progress dots. */
  const cycleDone = computed(() => state.value.completed % LONG_BREAK_EVERY)

  watch(state, (v) => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(v)) } catch { /* ignore */ }
  }, { deep: true })

  function setMode(mode: PomodoroMode) {
    state.value = { ...state.value, mode, endsAt: null, remainingMs: MODE_MINUTES[mode] * 60_000 }
  }

  function start() {
    if (running.value) return
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission()
    }
    state.value = { ...state.value, endsAt: Date.now() + state.value.remainingMs }
  }

  function pause() {
    if (!running.value) return
    state.value = { ...state.value, endsAt: null, remainingMs: remainingMs.value }
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

  // Tick only drives the display; completion is derived from endsAt.
  const timer = window.setInterval(() => {
    now.value = Date.now()
    if (running.value && remainingMs.value <= 0) finish()
  }, 250)
  onUnmounted(() => window.clearInterval(timer))

  return {
    mode: computed(() => state.value.mode),
    running, remainingMs, progress, display, cycleDone,
    setMode, toggle, reset, skip: advance,
  }
}
