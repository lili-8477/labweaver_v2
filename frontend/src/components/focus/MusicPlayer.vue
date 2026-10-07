<script setup lang="ts">
/**
 * Background music, YouTube-backed (same approach as nesto.cc).
 *
 * The embed is created lazily on first play, and is driven over the
 * iframe's postMessage API (enablejsapi=1) — no YouTube SDK script.
 * The player must stay mounted and at real size to keep playing, so a
 * parent hiding this component must park it off-screen, never use
 * v-if/v-show.
 */
import { ref, computed, watch } from 'vue'

interface Station { name: string; id: string; list?: boolean }

const STATIONS: Station[] = [
  { name: 'Lofi study', id: 'jfKfPfyJRdk' },
  { name: 'Lofi sleep', id: 'rUxyKA_-grg' },
  { name: 'Synthwave', id: '4xDzrJKXOOY' },
  { name: 'Chillhop', id: '5yx6BWlEVcY' },
]

const STORAGE_KEY = 'labweaver-music'

/** Accepts a YouTube URL (watch, youtu.be, live, playlist) or a bare video id. */
function parseYouTube(input: string): Station | null {
  const text = input.trim()
  if (/^[\w-]{11}$/.test(text)) return { name: 'Custom', id: text }
  let url: URL
  try { url = new URL(text) } catch { return null }
  if (!/(^|\.)youtube(-nocookie)?\.com$|^youtu\.be$/.test(url.hostname)) return null
  const v = url.searchParams.get('v')
    ?? (url.hostname === 'youtu.be' ? url.pathname.slice(1) : url.pathname.match(/\/(?:live|embed|shorts)\/([\w-]{11})/)?.[1])
  if (v && /^[\w-]{11}$/.test(v)) return { name: 'Custom', id: v }
  const list = url.searchParams.get('list')
  return list ? { name: 'Custom playlist', id: list, list: true } : null
}

const saved = (() => {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') } catch { return {} }
})() as { station?: Station; volume?: number }

const station = ref<Station>(saved.station ?? STATIONS[0])
const volume = ref<number>(saved.volume ?? 60)
const playing = ref(false)
const started = ref(false)   // iframe exists
const customUrl = ref('')
const customError = ref(false)
const frame = ref<HTMLIFrameElement | null>(null)

watch([station, volume], () => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ station: station.value, volume: volume.value }))
  } catch { /* ignore */ }
})

const src = computed(() => {
  const s = station.value
  const base = 'https://www.youtube-nocookie.com/embed/'
  const params = 'autoplay=1&enablejsapi=1&controls=0&disablekb=1&modestbranding=1&rel=0&playsinline=1'
  return s.list ? `${base}videoseries?list=${s.id}&${params}` : `${base}${s.id}?${params}`
})

function command(func: string, args: unknown[] = []) {
  frame.value?.contentWindow?.postMessage(JSON.stringify({ event: 'command', func, args }), '*')
}

function onFrameLoad() {
  command('setVolume', [volume.value])
}

function toggle() {
  if (!started.value) {
    started.value = true   // iframe mounts with autoplay=1
    playing.value = true
    return
  }
  command(playing.value ? 'pauseVideo' : 'playVideo')
  playing.value = !playing.value
}

function select(s: Station) {
  station.value = s
  started.value = true     // new src autoplays
  playing.value = true
}

function playCustom() {
  const s = parseYouTube(customUrl.value)
  customError.value = !s
  if (s) {
    select(s)
    customUrl.value = ''
  }
}

watch(volume, (v) => command('setVolume', [v]))

defineExpose({ playing, toggle })
</script>

<template>
  <div class="music">
    <div class="music-head">
      <button
        class="play"
        :class="{ on: playing }"
        @click="toggle"
        :aria-label="playing ? 'Pause music' : 'Play music'"
        :title="playing ? 'Pause music' : 'Play music'"
      >
        <svg v-if="playing" viewBox="0 0 16 16"><rect x="4" y="3" width="3" height="10" rx="1" /><rect x="9" y="3" width="3" height="10" rx="1" /></svg>
        <svg v-else viewBox="0 0 16 16"><path d="M5 3.2v9.6a.6.6 0 0 0 .9.5l7.6-4.8a.6.6 0 0 0 0-1L5.9 2.7a.6.6 0 0 0-.9.5Z" /></svg>
      </button>
      <div class="now">
        <span class="now-label">{{ playing ? 'Now playing' : 'Music' }}</span>
        <span class="now-name">{{ station.name }}</span>
      </div>
      <span v-if="playing" class="eq" aria-hidden="true"><i /><i /><i /></span>
    </div>

    <div class="stations" role="radiogroup" aria-label="Station">
      <button
        v-for="s in STATIONS"
        :key="s.id"
        class="chip"
        :class="{ active: s.id === station.id }"
        role="radio"
        :aria-checked="s.id === station.id"
        @click="select(s)"
      >{{ s.name }}</button>
    </div>

    <label class="volume">
      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 6h2l3-2.5v9L4.5 10h-2a.5.5 0 0 1-.5-.5v-3a.5.5 0 0 1 .5-.5Z" /><path d="M10 5.5a3.5 3.5 0 0 1 0 5M11.8 3.8a6 6 0 0 1 0 8.4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" /></svg>
      <input v-model.number="volume" type="range" min="0" max="100" aria-label="Volume" />
    </label>

    <form class="custom" @submit.prevent="playCustom">
      <input
        v-model="customUrl"
        :class="{ invalid: customError }"
        placeholder="Paste a YouTube link…"
        spellcheck="false"
        @input="customError = false"
      />
      <button type="submit" :disabled="!customUrl.trim()">Play</button>
    </form>

    <div class="player">
      <iframe
        v-if="started"
        ref="frame"
        :key="src"
        :src="src"
        title="Background music"
        allow="autoplay; encrypted-media"
        referrerpolicy="strict-origin-when-cross-origin"
        @load="onFrameLoad"
      />
    </div>
  </div>
</template>

<style scoped>
.music { display: flex; flex-direction: column; gap: var(--space-3); }

.music-head { display: flex; align-items: center; gap: var(--space-3); }
.play {
  width: 36px; height: 36px; flex-shrink: 0;
  display: grid; place-items: center;
  border-radius: 50%;
  border: 1px solid var(--border);
  background: var(--bg-tertiary);
  color: var(--text-primary);
  transition: background 0.15s, transform 0.15s var(--ease-out-quart);
}
.play:hover { background: var(--bg-hover); }
.play:active { transform: scale(0.94); }
.play.on { background: var(--accent-soft); color: var(--accent); border-color: color-mix(in oklch, var(--accent) 40%, transparent); }
.play svg { width: 14px; height: 14px; fill: currentColor; }

.now { display: flex; flex-direction: column; min-width: 0; flex: 1; line-height: 1.25; }
.now-label { font-size: var(--text-2xs); color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.08em; }
.now-name { font-weight: var(--fw-semi); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

.eq { display: inline-flex; align-items: flex-end; gap: 2px; height: 14px; }
.eq i { width: 3px; border-radius: 2px; background: var(--accent); animation: eq 0.9s ease-in-out infinite alternate; }
.eq i:nth-child(2) { animation-delay: -0.3s; }
.eq i:nth-child(3) { animation-delay: -0.6s; }
@keyframes eq { from { height: 3px; } to { height: 14px; } }

.stations { display: flex; flex-wrap: wrap; gap: 6px; }
.chip {
  padding: 3px 10px;
  border-radius: var(--radius-pill);
  border: 1px solid var(--border-soft);
  background: var(--bg-tertiary);
  color: var(--text-secondary);
  font-size: var(--text-xs);
  transition: all 0.12s;
}
.chip:hover { color: var(--text-primary); background: var(--bg-hover); }
.chip.active { color: var(--accent); border-color: color-mix(in oklch, var(--accent) 45%, transparent); background: var(--accent-soft); }

.volume { display: flex; align-items: center; gap: var(--space-2); color: var(--text-muted); }
.volume svg { width: 16px; height: 16px; fill: currentColor; flex-shrink: 0; }
.volume input { flex: 1; accent-color: var(--accent); }

.custom { display: flex; gap: 6px; }
.custom input {
  flex: 1; min-width: 0;
  padding: 5px 10px;
  border-radius: var(--radius-pill);
  border: 1px solid var(--border);
  background: var(--bg-primary);
  color: var(--text-primary);
  font-size: var(--text-xs);
}
.custom input:focus { outline: none; border-color: var(--accent); }
.custom input.invalid { border-color: var(--danger); }
.custom button {
  padding: 4px 12px;
  border-radius: var(--radius-pill);
  border: 1px solid var(--border);
  background: var(--bg-tertiary);
  color: var(--text-secondary);
  font-size: var(--text-xs);
}
.custom button:hover:not(:disabled) { color: var(--text-primary); background: var(--bg-hover); }
.custom button:disabled { opacity: 0.5; cursor: default; }

.player { border-radius: var(--radius); overflow: hidden; aspect-ratio: 16 / 9; }
.player:empty { display: none; }
.player iframe { width: 100%; height: 100%; border: 0; display: block; }
</style>
