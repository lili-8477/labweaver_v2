import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { natsService } from '@/services/nats'
import type {
  ChatInfo, ChatItem, StreamMessage, HarnessProgress, ChatMode, ProjectInfo,
} from '@/types'

// The user's message, shown until the turn's own user item arrives.
const PENDING_USER_ID = 'pending-user'

export const useChatStore = defineStore('chat', () => {
  const chats = ref<ChatInfo[]>([])
  const projects = ref<ProjectInfo[]>([])
  const activeChatId = ref<string | null>(null)
  // The active chat's items (types/index.ts ChatItem): history and live turn alike.
  const items = ref<ChatItem[]>([])
  const sending = ref(false)

  // Modes whose command is installed in this workspace (plain chat always is).
  const availableModes = ref<ChatMode[]>(['chat'])
  // Self-driving (tick harness) state. Whether it runs is the active chat's own
  // mode (see harnessActive below). Progress is parsed from the chat's project
  // progress.md by the adapter.
  const harnessProgress = ref<HarnessProgress | null>(null)
  // The project dir the adapter actually matched (chat-name path or fallback).
  // Surfaced in the banner so the user can tell which progress.md is being read.
  const harnessProject = ref<string | null>(null)

  let chatSubId: string | null = null

  const activeChat = computed(() => chats.value.find(c => c.id === activeChatId.value))
  // Auto mode covers one request: the adapter flips the chat back to plain
  // chat as it starts, and reports auto_running while that request runs.
  const harnessActive = computed(() =>
    activeChat.value?.mode === 'auto' || !!activeChat.value?.auto_running)

  // ---- Chat CRUD ----

  async function loadChats() {
    try {
      const result = await natsService.invoke('list_chats') as { success: boolean; chats: ChatInfo[] }
      if (result?.success) {
        chats.value = result.chats.sort((a, b) => {
          const da = a.last_activity_date || ''
          const db = b.last_activity_date || ''
          return db.localeCompare(da)
        })
      }
    } catch (e) {
      console.warn('Failed to load chats:', e)
    }
  }

  async function loadProjects() {
    try {
      const result = await natsService.invoke('list_projects') as { success: boolean; projects: ProjectInfo[] }
      if (result?.success) projects.value = result.projects
    } catch (e) {
      console.warn('Failed to load projects:', e)
    }
  }

  /** Create a project folder under local_projects/; returns its dir. */
  async function createProject(name: string): Promise<string | null> {
    const result = await natsService.invoke('create_project', { name }) as { success: boolean; project: ProjectInfo }
    if (!result?.success) return null
    await loadProjects()
    return result.project.dir
  }

  /** opts.projectDir creates the chat inside that project. opts.parentChatId
   *  creates a sub-session instead: it inherits the parent's project and mode
   *  and is seeded with the parent conversation on its first turn. */
  async function createChat(
    name?: string,
    opts: { parentChatId?: string; projectDir?: string } = {},
  ): Promise<string | null> {
    const result = await natsService.invoke('create_chat', {
      chat_name: name || undefined,
      parent_chat_id: opts.parentChatId,
      project_dir: opts.projectDir,
    }) as { success: boolean; chat_id: string }
    if (result?.success) {
      await loadChats()
      return result.chat_id
    }
    return null
  }

  async function deleteChat(chatId: string) {
    await natsService.invoke('delete_chat', { chat_id: chatId })
    if (activeChatId.value === chatId) {
      activeChatId.value = null
      items.value = []
    }
    await loadChats()
  }

  async function loadItems(chatId: string) {
    const result = await natsService.invoke('get_chat_items', { chat_id: chatId }) as { success: boolean; items: ChatItem[] }
    if (result?.success && activeChatId.value === chatId) items.value = result.items || []
  }

  /** Add an item, or replace the one with its id (a tool item gains its result). */
  function upsert(item: ChatItem) {
    const list = items.value.filter(it => !(item.kind === 'user' && it.id === PENDING_USER_ID))
    const i = list.findIndex(it => it.id === item.id)
    if (i >= 0) list[i] = item
    else list.push(item)
    items.value = list
  }

  // ---- Chat selection & streaming ----

  async function selectChat(chatId: string) {
    if (chatSubId) {
      natsService.unsubscribe(chatSubId)
      chatSubId = null
    }

    activeChatId.value = chatId
    sending.value = !!chats.value.find(c => c.id === chatId)?.running
    items.value = []

    await loadItems(chatId)

    chatSubId = natsService.subscribe(`chat_${chatId}`, handleStreamMessage)
  }

  // ---- Stream message handling ----

  function handleStreamMessage(msg: StreamMessage) {
    if (msg.type !== 'chat') return
    const data = msg.data
    if (data.chat_id !== activeChatId.value) return

    switch (data.type) {
      case 'item':
        upsert(data.item)
        break
      case 'chat_finished':
        if (data.status === 'error') console.error('Chat error:', data.error)
        sending.value = false
        // Live items already match the transcript; reloading drops a pending
        // user message the turn never recorded (e.g. it failed to start).
        loadItems(data.chat_id)
        loadChats()
        break
    }
  }

  // ---- Send / Stop ----

  async function sendMessage(content: string, imagePaths: string[] = []) {
    const trimmed = content.trim()
    if (!activeChatId.value || (!trimmed && imagePaths.length === 0)) return
    sending.value = true

    // Prepend `[image: <path>]` lines so Claude Code reads them via the Read
    // tool. The agent sees these as part of the user turn alongside the text.
    const prefix = imagePaths.map(p => `[image: ${p}]`).join('\n')
    const fullContent = prefix
      ? (trimmed ? `${prefix}\n${trimmed}` : prefix)
      : trimmed

    upsert({ kind: 'user', id: PENDING_USER_ID, text: fullContent })

    // The adapter acknowledges once the turn starts; chat_finished ends it.
    const chatId = activeChatId.value
    try {
      await natsService.invoke('chat', {
        chat_id: chatId,
        message: [{ role: 'user', content: fullContent }],
      })
    } catch (e) {
      console.error('Chat error:', e)
      if (activeChatId.value === chatId) sending.value = false
    }
    loadChats()
  }

  async function stopChat() {
    if (!activeChatId.value) return
    const chatId = activeChatId.value
    try {
      const res = await natsService.invoke('stop_chat', { chat_id: chatId }) as { stopped?: boolean }
      if (res?.stopped) return // the turn's chat_finished does the rest
    } catch { /* ignore */ }
    await loadItems(chatId)
    sending.value = false
  }

  async function updateChatName(chatId: string, name: string) {
    await natsService.invoke('update_chat_name', { chat_id: chatId, chat_name: name })
    await loadChats()
  }

  // ---- Self-driving (tick harness) ----

  async function refreshAvailableModes() {
    try {
      const res = await natsService.invoke('get_available_modes', {}) as { modes?: ChatMode[] }
      if (res?.modes) availableModes.value = res.modes
    } catch { /* ignore — keep last known value */ }
  }

  /** Switch one chat between modes; other chats keep theirs. */
  async function setChatMode(chatId: string, mode: ChatMode): Promise<void> {
    await natsService.invoke('set_chat_mode', { chat_id: chatId, mode })
    const c = chats.value.find(x => x.id === chatId)
    if (c) c.mode = mode
  }

  async function refreshHarnessProgress() {
    // The adapter resolves which progress.md to read in this order:
    //   chat_id → chats.project_dir → legacy name-match → project_name hint.
    // Passing chat_id keeps each session isolated to its own bound project.
    const chatId = activeChatId.value
    if (!chatId) {
      harnessProgress.value = null
      harnessProject.value = null
      return
    }
    try {
      const res = await natsService.invoke('get_harness_progress', {
        chat_id: chatId,
        // Sent as a hint for chats with no DB binding yet — the backend only
        // uses it as the last-resort lookup after chat_id paths miss.
        project_name: activeChat.value?.name,
      }) as {
        success?: boolean; exists?: boolean;
        progress?: HarnessProgress | null;
        project_name?: string | null;
        project_dir?: string | null;
      }
      if (res?.exists) {
        harnessProgress.value = res.progress ?? null
        harnessProject.value = res.project_name ?? null
      } else {
        harnessProgress.value = null
        harnessProject.value = null
      }
    } catch {
      harnessProgress.value = null
      harnessProject.value = null
    }
  }

  /** Bind a chat to a project directory. Pass empty string to unbind. */
  async function setChatProjectDir(chatId: string, projectDir: string): Promise<void> {
    await natsService.invoke('set_chat_project_dir', {
      chat_id: chatId,
      project_dir: projectDir,
    })
    // Update the local list so the UI doesn't have to wait for a list_chats
    // round-trip to reflect the binding.
    const c = chats.value.find(x => x.id === chatId)
    if (c) c.project_dir = projectDir || null
  }

  return {
    chats, projects, activeChatId, activeChat, items, sending,
    harnessActive, availableModes, harnessProgress, harnessProject,
    loadChats, loadProjects, createProject, createChat, deleteChat, selectChat, sendMessage,
    stopChat, updateChatName,
    refreshAvailableModes, refreshHarnessProgress, setChatProjectDir, setChatMode,
  }
})
