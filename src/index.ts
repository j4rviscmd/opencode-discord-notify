import type { Plugin } from '@opencode-ai/plugin'
import { PersistentQueue } from './queue/persistent-queue.js'
import { QueueWorker } from './queue/worker.js'
import { initDatabase } from './utils/db.js'

// ================================================================================
// Type Definitions
// ================================================================================

type DiscordWebhookMessageResponse = {
  id: string
  channel_id: string
}

type DiscordEmbed = {
  title?: string
  description?: string
  url?: string
  color?: number
  timestamp?: string
  fields?: Array<{ name: string; value: string; inline?: boolean }>
}

type DiscordAllowedMentions = {
  parse?: Array<'everyone' | 'roles' | 'users'>
  roles?: string[]
  users?: string[]
}

export type DiscordExecuteWebhookBody = {
  content?: string
  username?: string
  avatar_url?: string
  thread_name?: string
  embeds?: DiscordEmbed[]
  allowed_mentions?: DiscordAllowedMentions
}

type SendParamKey =
  | 'sessionID'
  | 'permissionID'
  | 'permission'
  | 'patterns'
  | 'messageID'
  | 'callID'
  | 'partID'
  | 'role'
  | 'directory'
  | 'projectID'

// ================================================================================
// Constants
// ================================================================================

// Discord API制限
const DISCORD_FIELD_VALUE_MAX_LENGTH = 1024
const DISCORD_EMBED_DESCRIPTION_MAX_LENGTH = 4096
const DISCORD_THREAD_NAME_MAX_LENGTH = 100
const ELLIPSIS = '...'
const ELLIPSIS_LENGTH = 3

// UI設定
const TOAST_DURATION_MS = 8000
const TOAST_COOLDOWN_MS = 30_000
const TODO_ITEM_DISPLAY_MAX_LENGTH = 200

// HTTP
const HTTP_STATUS_TOO_MANY_REQUESTS = 429
const MS_PER_SECOND = 1000

// レート制限
const DEFAULT_RATE_LIMIT_WAIT_MS = 10_000

const SEND_PARAM_KEYS: SendParamKey[] = [
  'sessionID',
  'permissionID',
  'permission',
  'patterns',
  'messageID',
  'callID',
  'partID',
  'role',
  'directory',
  'projectID',
]

const SEND_PARAM_KEY_SET = new Set<SendParamKey>(SEND_PARAM_KEYS)

const COLORS = {
  info: 0x5865f2,
  success: 0x57f287,
  warning: 0xfee75c,
  error: 0xed4245,
} as const

// ================================================================================
// Utility Functions
// ================================================================================

function safeString(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function toIsoTimestamp(ms: unknown): string | undefined {
  if (typeof ms !== 'number') return undefined
  if (!Number.isFinite(ms)) return undefined
  return new Date(ms).toISOString()
}

function buildFields(
  fields: Array<[string, unknown]>,
  inline = false,
): DiscordEmbed['fields'] {
  const result: NonNullable<DiscordEmbed['fields']> = []
  for (const [name, rawValue] of fields) {
    const value = safeString(rawValue)
    if (!value) continue

    // Discord API制限: フィールド値は最大1024文字
    const truncatedValue =
      value.length > DISCORD_FIELD_VALUE_MAX_LENGTH
        ? value.slice(0, DISCORD_FIELD_VALUE_MAX_LENGTH - ELLIPSIS_LENGTH) +
          ELLIPSIS
        : value

    result.push({
      name,
      value: truncatedValue,
      inline,
    })
  }
  return result.length ? result : undefined
}

function isSendParamKey(value: string): value is SendParamKey {
  return SEND_PARAM_KEY_SET.has(value as SendParamKey)
}

function filterSendFields(
  fields: Array<[string, unknown]>,
  allowed: Set<SendParamKey>,
): Array<[string, unknown]> {
  return fields.filter(([name]) => {
    if (!isSendParamKey(name)) return false
    return allowed.has(name)
  })
}

function getTextPartEmbedTitle(role: 'user' | 'assistant'): string {
  return role === 'user' ? 'User says' : 'Agent says'
}

function withForcedSendParams(
  base: Set<SendParamKey>,
  forced: SendParamKey[],
): Set<SendParamKey> {
  const next = new Set(base)
  for (const key of forced) next.add(key)
  return next
}

function getEnv(name: string): string | undefined {
  try {
    return process.env[name]
  } catch {
    return undefined
  }
}

function parseSendParams(raw: string | undefined): Set<SendParamKey> {
  if (raw === undefined) return new Set()

  const tokens = raw
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean)

  if (!tokens.length) return new Set()

  const result = new Set<SendParamKey>()
  for (const token of tokens) {
    if (!SEND_PARAM_KEY_SET.has(token as SendParamKey)) continue
    result.add(token as SendParamKey)
  }
  return result
}

function withQuery(
  url: string,
  params: Record<string, string | undefined>,
): string {
  const u = new URL(url)
  for (const [k, v] of Object.entries(params)) {
    if (!v) continue
    u.searchParams.set(k, v)
  }
  return u.toString()
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value
  if (maxLength <= 3) return value.slice(0, maxLength)
  return `${value.slice(0, maxLength - 3)}...`
}

function buildMention(
  mention: string | undefined,
  nameForLog: string,
): { content?: string; allowed_mentions?: DiscordAllowedMentions } | undefined {
  void nameForLog

  if (!mention) return undefined

  if (mention === '@everyone' || mention === '@here') {
    return {
      content: mention,
      allowed_mentions: {
        parse: ['everyone'],
      },
    }
  }

  return {
    content: mention,
    allowed_mentions: {
      parse: [],
    },
  }
}

function normalizeTodoContent(value: unknown): string {
  return safeString(value).replace(/\s+/g, ' ').trim()
}

/**
 * Todoアイテムのステータスに応じたマーカーを取得
 */
function getTodoStatusMarker(status: string | undefined): string {
  if (status === 'completed') return '[✓]'
  if (status === 'in_progress') return '[▶]'
  return '[ ]'
}

/**
 * Todoリストをチェックリスト形式の文字列に変換
 * Discord API制限: description最大4096文字
 */
function buildTodoChecklist(todos: unknown): string {
  const items = Array.isArray(todos) ? todos : []

  let matchCount = 0
  let description = ''
  let truncated = false

  for (const item of items) {
    const status = (item as any)?.status as string | undefined

    // キャンセル済みアイテムはスキップ
    if (status === 'cancelled') continue

    const content = normalizeTodoContent((item as any)?.content)
    if (!content) continue

    const marker = getTodoStatusMarker(status)
    const line = `> ${marker} ${truncateText(content, TODO_ITEM_DISPLAY_MAX_LENGTH)}`

    const nextChunk = (description ? '\n' : '') + line
    if (
      description.length + nextChunk.length >
      DISCORD_EMBED_DESCRIPTION_MAX_LENGTH
    ) {
      truncated = true
      break
    }

    description += nextChunk
    matchCount += 1
  }

  if (!description) {
    return '> (no todos)'
  }

  // 切り捨てられた、または表示されていないアイテムがある場合
  if (truncated || matchCount < items.length) {
    const moreLine = `${description ? '\n' : ''}> ...and more`
    if (
      description.length + moreLine.length <=
      DISCORD_EMBED_DESCRIPTION_MAX_LENGTH
    ) {
      description += moreLine
    }
  }

  return description
}

type DiscordRateLimitResponse = {
  retry_after?: number
}

type ToastVariant = 'info' | 'success' | 'warning' | 'error'

type ShowToast = (input: {
  title?: string
  message: string
  variant: ToastVariant
}) => Promise<void>

type MaybeAlertError = (input: {
  key: string
  title?: string
  message: string
  variant: ToastVariant
}) => Promise<void>

type PostDiscordWebhookDeps = {
  showErrorAlert: boolean
  maybeAlertError: MaybeAlertError
  waitOnRateLimitMs: number
  fetchImpl?: typeof fetch
  sleepImpl?: (ms: number) => Promise<void>
}

async function postDiscordWebhook(
  input: {
    webhookUrl: string
    threadId?: string
    wait?: boolean
    body: DiscordExecuteWebhookBody
  },
  deps: PostDiscordWebhookDeps,
): Promise<DiscordWebhookMessageResponse | undefined> {
  const { webhookUrl, threadId, wait, body } = input

  const fetchImpl = deps.fetchImpl ?? (globalThis as any).fetch
  const sleepImpl = deps.sleepImpl ?? sleep

  const url = withQuery(webhookUrl, {
    thread_id: threadId,
    wait: wait ? 'true' : undefined,
  })

  const requestInit: RequestInit = {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  }

  const doRequest = async () => {
    return await fetchImpl(url, requestInit)
  }

  const parseRetryAfterFromText = (text: string): number | undefined => {
    if (!text) return undefined
    try {
      const json = JSON.parse(text) as DiscordRateLimitResponse
      const value = json?.retry_after
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
        return value
      }
    } catch {
      // ignore
    }
    return undefined
  }

  const parseRetryAfterFromHeader = (headers: Headers): number | undefined => {
    const raw = headers.get('Retry-After')
    if (!raw) return undefined
    const value = Number(raw)
    if (!Number.isFinite(value) || value < 0) return undefined
    return value
  }

  const response = await doRequest()
  if (response.ok) {
    if (!wait) return undefined
    const json = (await response.json().catch(() => undefined)) as
      | DiscordWebhookMessageResponse
      | undefined
    if (!json || typeof json !== 'object') return undefined
    const channelId = (json as any).channel_id
    const messageId = (json as any).id
    if (typeof channelId !== 'string' || typeof messageId !== 'string')
      return undefined
    return { id: messageId, channel_id: channelId }
  }

  // レート制限エラー（HTTP 429）の処理
  if (response.status === HTTP_STATUS_TOO_MANY_REQUESTS) {
    const text = await response.text().catch(() => '')
    const retryAfterSeconds =
      parseRetryAfterFromText(text) ??
      parseRetryAfterFromHeader(response.headers)

    const waitMs =
      retryAfterSeconds === undefined
        ? deps.waitOnRateLimitMs
        : Math.ceil(retryAfterSeconds * MS_PER_SECOND)

    await sleepImpl(waitMs)
    const retryResponse = await doRequest()

    if (!retryResponse.ok) {
      if (deps.showErrorAlert) {
        await deps.maybeAlertError({
          key: `discord_webhook_error:${retryResponse.status}`,
          title: 'Discord webhook rate-limited',
          message: `Discord webhook returned ${HTTP_STATUS_TOO_MANY_REQUESTS} (rate limited). Waited ${Math.round(
            waitMs / MS_PER_SECOND,
          )}s and retried, but it still failed.`,
          variant: 'warning',
        })
      }

      const retryText = await retryResponse.text().catch(() => '')
      throw new Error(
        `Discord webhook failed: ${retryResponse.status} ${retryResponse.statusText} ${retryText}`,
      )
    }

    if (!wait) return undefined
    const json = (await retryResponse.json().catch(() => undefined)) as
      | DiscordWebhookMessageResponse
      | undefined
    if (!json || typeof json !== 'object') return undefined
    const channelId = (json as any).channel_id
    const messageId = (json as any).id
    if (typeof channelId !== 'string' || typeof messageId !== 'string')
      return undefined
    return { id: messageId, channel_id: channelId }
  }

  // other errors
  if (deps.showErrorAlert) {
    await deps.maybeAlertError({
      key: `discord_webhook_error:${response.status}`,
      title: 'Discord webhook error',
      message: `Discord webhook failed: ${response.status} ${response.statusText}`,
      variant: 'error',
    })
  }

  const text = await response.text().catch(() => '')
  throw new Error(
    `Discord webhook failed: ${response.status} ${response.statusText} ${text}`,
  )
}

/**
 * フォールバック先Webhookへメンションを含むメッセージを送信
 * フォールバック投稿時は、常にセッションIDとスレッドタイトル（最初のユーザー発言）をembed fieldsに含める
 */
async function postFallbackIfNeeded(
  input: {
    body: DiscordExecuteWebhookBody
    mention:
      | { content?: string; allowed_mentions?: DiscordAllowedMentions }
      | undefined
    sessionID: string
    fallbackUrl: string | undefined
    firstUserTextBySession: Map<string, string>
    lastSessionInfo: Map<string, { title?: string; shareUrl?: string }>
  },
  deps: PostDiscordWebhookDeps,
): Promise<void> {
  const {
    body,
    mention,
    sessionID,
    fallbackUrl,
    firstUserTextBySession,
    lastSessionInfo,
  } = input

  // フォールバックURLが未設定、またはメンションがない場合は何もしない
  if (!fallbackUrl || !mention) return

  // フォールバック用のbodyを作成
  // embedsを複製し、常にセッションIDとスレッドタイトルをfieldsに追加
  const fallbackBody: DiscordExecuteWebhookBody = {
    ...body,
    // thread_nameは削除（テキストチャネルでは不要）
    thread_name: undefined,
  }

  // embedsが存在する場合、最初のembedにセッションIDとスレッドタイトルを追加
  if (fallbackBody.embeds && fallbackBody.embeds.length > 0) {
    const originalEmbed = fallbackBody.embeds[0]

    // スレッドタイトルを取得（優先順位: 最初のユーザーテキスト > セッションタイトル）
    const threadTitle =
      firstUserTextBySession.get(sessionID) ||
      lastSessionInfo.get(sessionID)?.title

    // 既存のfieldsにセッションIDとスレッドタイトルを追加
    const additionalFields = buildFields([
      ['sessionID', sessionID],
      ['thread title', threadTitle],
    ])

    fallbackBody.embeds = [
      {
        ...originalEmbed,
        fields: [...(originalEmbed.fields ?? []), ...(additionalFields ?? [])],
      },
    ]
  }

  try {
    await postDiscordWebhook(
      {
        webhookUrl: fallbackUrl,
        body: fallbackBody,
      },
      deps,
    )
  } catch (e) {
    // フォールバック送信エラーは既存のエラーハンドリングに任せる
    // maybeAlertErrorが内部で呼ばれるのでここでは何もしない
  }
}

const GLOBAL_GUARD_KEY = '__opencode_discord_notify_registered__'

type GlobalThisWithGuard = typeof globalThis & {
  [GLOBAL_GUARD_KEY]?: boolean
}

const plugin: Plugin = async ({ client }) => {
  const globalWithGuard = globalThis as GlobalThisWithGuard
  if (globalWithGuard[GLOBAL_GUARD_KEY]) {
    return { event: async () => {} }
  }
  globalWithGuard[GLOBAL_GUARD_KEY] = true

  const webhookUrl = getEnv('DISCORD_WEBHOOK_URL')
  const username = getEnv('DISCORD_WEBHOOK_USERNAME')
  const avatarUrl = getEnv('DISCORD_WEBHOOK_AVATAR_URL')

  const completeMentionRaw = (
    getEnv('DISCORD_WEBHOOK_COMPLETE_MENTION') ?? ''
  ).trim()
  const completeMention = completeMentionRaw || undefined

  const permissionMentionRaw = (
    getEnv('DISCORD_WEBHOOK_PERMISSION_MENTION') ?? ''
  ).trim()
  const permissionMention = permissionMentionRaw || undefined

  const excludeInputContextRaw = (
    getEnv('DISCORD_WEBHOOK_EXCLUDE_INPUT_CONTEXT') ?? '1'
  ).trim()
  const excludeInputContext = excludeInputContextRaw !== '0'

  const showErrorAlertRaw = (
    getEnv('DISCORD_WEBHOOK_SHOW_ERROR_ALERT') ?? '1'
  ).trim()
  const showErrorAlert = showErrorAlertRaw !== '0'

  const includeLastMessageInCompleteRaw = (
    getEnv('DISCORD_WEBHOOK_COMPLETE_INCLUDE_LAST_MESSAGE') ?? '1'
  ).trim()
  const includeLastMessageInComplete = includeLastMessageInCompleteRaw !== '0'

  const waitOnRateLimitMs = DEFAULT_RATE_LIMIT_WAIT_MS

  const sendParams = parseSendParams(getEnv('DISCORD_SEND_PARAMS'))

  const fallbackWebhookUrl =
    (getEnv('DISCORD_WEBHOOK_FALLBACK_URL') ?? '').trim() || undefined

  const lastAlertAtByKey = new Map<string, number>()
  // 既送 partID を保持
  const sentTextPartIds = new Set<string>()

  const showToast: ShowToast = async ({ title, message, variant }) => {
    try {
      await client.tui.showToast({
        body: { title, message, variant, duration: TOAST_DURATION_MS },
      } as any)
    } catch {
      // noop
    }
  }

  const maybeAlertError: MaybeAlertError = async ({
    key,
    title,
    message,
    variant,
  }) => {
    if (!showErrorAlert) return
    const now = Date.now()
    const last = lastAlertAtByKey.get(key)
    if (last !== undefined && now - last < TOAST_COOLDOWN_MS) return
    lastAlertAtByKey.set(key, now)
    await showToast({ title, message, variant })
  }

  const MISSING_URL_KEY = 'discord_webhook_missing_url'
  async function showMissingUrlToastOnce() {
    const now = Date.now()
    const last = lastAlertAtByKey.get(MISSING_URL_KEY)
    if (last !== undefined && now - last < TOAST_COOLDOWN_MS) return
    lastAlertAtByKey.set(MISSING_URL_KEY, now)
    await showToast({
      title: 'Discord webhook not configured',
      message:
        'DISCORD_WEBHOOK_URL is not set. Please configure it to enable Discord notifications.',
      variant: 'warning',
    })
  }

  if (!webhookUrl) void showMissingUrlToastOnce()

  const postDeps: PostDiscordWebhookDeps = {
    showErrorAlert,
    maybeAlertError,
    waitOnRateLimitMs,
  }

  // DB初期化
  const db = initDatabase()
  const persistentQueue = new PersistentQueue({ db })

  const sessionToThread = new Map<string, string>()

  // ワーカー初期化（buildThreadNameは後で定義されるため、関数として渡す）
  const queueWorker = new QueueWorker({
    queue: persistentQueue,
    postWebhook: postDiscordWebhook,
    postDeps,
    maybeAlertError,
    webhookUrl: webhookUrl ?? '',
    username,
    avatarUrl,
    buildThreadName: (sessionID: string) => buildThreadName(sessionID),
    onThreadCreated: (sessionID: string, threadID: string) => {
      sessionToThread.set(sessionID, threadID)
    },
  })
  const firstUserTextBySession = new Map<string, string>()
  const lastAssistantMessageBySession = new Map<string, string>()
  const pendingTextPartsByMessageId = new Map<string, any[]>()
  const messageRoleById = new Map<string, 'user' | 'assistant'>()
  /**
   * セッション情報のキャッシュ
   * - session.created時に保存
   * - 初回ユーザーメッセージ時にsession.created embedの生成に使用
   */
  const lastSessionInfo = new Map<
    string,
    {
      title?: string
      shareUrl?: string
      createdAt?: string
      projectID?: string
      directory?: string
    }
  >()

  function normalizeThreadTitle(value: unknown): string {
    return safeString(value).replace(/\s+/g, ' ').trim()
  }

  function isInputContextText(text: string): boolean {
    return text.trimStart().startsWith('<file>')
  }

  /**
   * セッションIDからスレッド名を生成
   * 優先順位: ユーザーテキスト > セッションタイトル > セッションID > '(untitled)'
   * Discord API制限: スレッド名最大100文字
   */
  function buildThreadName(sessionID: string): string {
    const fromUser = normalizeThreadTitle(firstUserTextBySession.get(sessionID))
    if (fromUser) return fromUser.slice(0, DISCORD_THREAD_NAME_MAX_LENGTH)

    const fromSessionTitle = normalizeThreadTitle(
      lastSessionInfo.get(sessionID)?.title,
    )
    if (fromSessionTitle)
      return fromSessionTitle.slice(0, DISCORD_THREAD_NAME_MAX_LENGTH)

    const fromSessionId = normalizeThreadTitle(
      sessionID ? `session ${sessionID}` : '',
    )
    if (fromSessionId)
      return fromSessionId.slice(0, DISCORD_THREAD_NAME_MAX_LENGTH)

    return '(untitled)'
  }

  /**
   * セッション開始通知のembedを生成
   * - 初回ユーザーメッセージ時に呼び出される
   * - lastSessionInfoから保存済みのセッション情報を取得して使用
   *
   * @param sessionID - セッションID
   * @returns Discord embed（セッション情報が存在しない場合はundefined）
   */
  function buildSessionCreatedEmbed(
    sessionID: string,
  ): DiscordExecuteWebhookBody | undefined {
    const info = lastSessionInfo.get(sessionID)
    if (!info) return undefined

    const embed: DiscordEmbed = {
      title: 'Session started',
      description: info.title,
      url: info.shareUrl,
      color: COLORS.info,
      timestamp: info.createdAt,
      fields: buildFields(
        filterSendFields(
          [
            ['sessionID', sessionID],
            ['projectID', info.projectID],
            ['directory', info.directory],
            ['share', info.shareUrl],
          ],
          withForcedSendParams(sendParams, ['sessionID']),
        ),
      ),
    }

    return { embeds: [embed] }
  }

  function enqueueToThread(sessionID: string, body: DiscordExecuteWebhookBody) {
    if (!webhookUrl) {
      // show a one-time warning to the user (non-blocking) and do not queue
      void showMissingUrlToastOnce()
      return
    }

    const threadId = sessionToThread.get(sessionID) || null
    persistentQueue.enqueue({
      sessionId: sessionID,
      threadId,
      webhookBody: body,
    })
  }

  function startWorkerIfNeeded() {
    if (!queueWorker.running) {
      void queueWorker.start()
    }
  }

  function buildCompleteMention():
    | { content?: string; allowed_mentions?: DiscordAllowedMentions }
    | undefined {
    return buildMention(completeMention, 'DISCORD_WEBHOOK_COMPLETE_MENTION')
  }

  function buildPermissionMention():
    | { content?: string; allowed_mentions?: DiscordAllowedMentions }
    | undefined {
    return buildMention(permissionMention, 'DISCORD_WEBHOOK_PERMISSION_MENTION')
  }
  /**
   * Discord のメンションをエスケープする
   * @param text
   * @returns
   */
  function escapeDiscordMention(text: string): string {
    return text.replace(/^@/g, '@\u200b')
  }

  async function handleTextPart(input: {
    part: any
    role: 'user' | 'assistant'
    sessionID: string
    messageID: string
    replay?: boolean
  }) {
    const { part, role, sessionID, messageID, replay } = input
    const partID = part?.id as string | undefined
    if (!partID) return
    if (!replay && role === 'assistant' && !part?.time?.end) return

    if (sentTextPartIds.has(partID)) return
    sentTextPartIds.add(partID)

    const text = escapeDiscordMention(safeString(part?.text))

    if (role === 'user' && excludeInputContext && isInputContextText(text)) {
      return
    }
    if ((role === 'user' && text.trim() === '') || text.trim() === '(empty)') {
      return
    }

    // 初回ユーザーテキストを保存（スレッド名に使用）
    const isFirstUserText =
      role === 'user' && !firstUserTextBySession.has(sessionID)
    if (isFirstUserText) {
      const normalized = normalizeThreadTitle(text)
      if (normalized) firstUserTextBySession.set(sessionID, normalized)
    }

    // 最新アシスタント発言を保存（session.idle通知に使用）
    if (role === 'assistant' && text.trim()) {
      lastAssistantMessageBySession.set(sessionID, text)
    }

    /**
     * 初回ユーザーメッセージ時の処理（Option 3実装）
     * - スレッドが未作成 かつ ユーザーメッセージの場合
     * - session.created embedを先にenqueueしてからUser says embedをenqueue
     * - これにより、スレッド作成時に正しいユーザーテキストがスレッド名に使用される
     */
    if (role === 'user' && !sessionToThread.has(sessionID)) {
      const sessionCreatedBody = buildSessionCreatedEmbed(sessionID)
      if (sessionCreatedBody) {
        enqueueToThread(sessionID, sessionCreatedBody)
      }
    }

    const embed: DiscordEmbed = {
      title: getTextPartEmbedTitle(role),
      color: COLORS.info,
      fields: buildFields(
        filterSendFields(
          [
            ['sessionID', sessionID],
            ['messageID', messageID],
            ['partID', partID],
            ['role', role],
          ],
          sendParams,
        ),
      ),
      description: truncateText(
        text || '(empty)',
        DISCORD_EMBED_DESCRIPTION_MAX_LENGTH,
      ),
    }

    enqueueToThread(sessionID, { embeds: [embed] })

    // キューにメッセージを追加したので、ワーカーを起動して即座に処理開始
    startWorkerIfNeeded()
  }

  return {
    event: async ({ event }) => {
      try {
        // NOTE: SDK型定義がv1.1.1+の新しいイベント(permission.asked)を
        // まだ含んでいないため、stringにキャストして対応
        switch (event.type as string) {
          case 'session.created': {
            const info = (event.properties as any)?.info
            const sessionID = info?.id as string | undefined
            if (!sessionID) return

            // セッション情報を保存（初回ユーザーメッセージ時に使用）
            lastSessionInfo.set(sessionID, {
              title: info?.title as string | undefined,
              shareUrl: info?.share?.url as string | undefined,
              createdAt: toIsoTimestamp(info?.time?.created),
              projectID: info?.projectID as string | undefined,
              directory: info?.directory as string | undefined,
            })

            // NOTE: Option 3実装
            // session.created時はenqueueせず、初回ユーザーメッセージ時にenqueueする。
            // 理由: ワーカーが別セッションで既に起動している場合、
            // ユーザーテキストが来る前にsession.createdメッセージが処理され、
            // スレッド名がユーザー発話ではなくセッションタイトルになってしまうため。
            //
            // 初回ユーザーメッセージ時の処理:
            // 1. buildSessionCreatedEmbed()でsession.created embedを生成
            // 2. User says embedの前にenqueue
            // 3. ワーカー起動
            return
          }

          case 'permission.asked': {
            const p = event.properties as any
            const sessionID = p?.sessionID as string | undefined
            if (!sessionID) return

            const mention = buildPermissionMention()

            // patterns配列を文字列に変換（複数パターンはカンマ区切り）
            const patternsArray = p?.patterns as string[] | undefined
            const patternsStr = Array.isArray(patternsArray)
              ? patternsArray.join(', ')
              : undefined

            const embed: DiscordEmbed = {
              title: 'Permission required',
              description: p?.title as string | undefined,
              color: COLORS.warning,
              timestamp: toIsoTimestamp(p?.time?.created),
              fields: buildFields(
                filterSendFields(
                  [
                    ['sessionID', sessionID],
                    ['permissionID', p?.id],
                    ['permission', p?.permission],
                    ['patterns', patternsStr],
                    ['messageID', p?.tool?.messageID],
                    ['callID', p?.tool?.callID],
                  ],
                  sendParams,
                ),
              ),
            }

            // プッシュ通知用の概要テキストを生成
            // 形式: "Bash(curl -i https://...)" or "Bash" or "Permission requested"
            const permissionType = (p?.permission as string) || ''
            const permissionDetail = patternsStr || ''
            const permissionSummary = truncateText(
              (p?.title as string) ||
                (permissionType && permissionDetail
                  ? `${permissionType}(${permissionDetail})`
                  : permissionType || 'Permission requested'),
              100,
            )

            const body: DiscordExecuteWebhookBody = {
              content: mention
                ? `${mention.content} Permission: ${permissionSummary}`
                : undefined,
              allowed_mentions: mention?.allowed_mentions,
              embeds: [embed],
            }

            enqueueToThread(sessionID, body)

            // フォールバック送信（メンションがある場合のみ）
            await postFallbackIfNeeded(
              {
                body,
                mention,
                sessionID,
                fallbackUrl: fallbackWebhookUrl,
                firstUserTextBySession,
                lastSessionInfo,
              },
              postDeps,
            )

            // キューにメッセージを追加したので、ワーカーを起動して即座に処理開始
            startWorkerIfNeeded()
            return
          }

          case 'session.idle': {
            const sessionID = (event.properties as any)?.sessionID as
              | string
              | undefined
            if (!sessionID) return

            const mention = buildCompleteMention()

            // 最新アシスタント発言を取得（オプトアウト可能）
            const lastMessage = includeLastMessageInComplete
              ? lastAssistantMessageBySession.get(sessionID)
              : undefined

            const embed: DiscordEmbed = {
              title: 'Session completed',
              color: COLORS.success,
              description: lastMessage
                ? truncateText(
                    lastMessage,
                    DISCORD_EMBED_DESCRIPTION_MAX_LENGTH,
                  )
                : undefined,
              fields: buildFields(
                filterSendFields([['sessionID', sessionID]], sendParams),
              ),
            }

            const body: DiscordExecuteWebhookBody = {
              content: mention
                ? `${mention.content} Session completed`
                : undefined,
              allowed_mentions: mention?.allowed_mentions,
              embeds: [embed],
            }

            enqueueToThread(sessionID, body)

            // フォールバック送信（メンションがある場合のみ）
            await postFallbackIfNeeded(
              {
                body,
                mention,
                sessionID,
                fallbackUrl: fallbackWebhookUrl,
                firstUserTextBySession,
                lastSessionInfo,
              },
              postDeps,
            )

            // キューにメッセージを追加したので、ワーカーを起動して即座に処理開始
            startWorkerIfNeeded()
            return
          }

          case 'session.error': {
            const p = event.properties as any
            const sessionID = p?.sessionID as string | undefined

            const errorStr = safeString(p?.error)
            const embed: DiscordEmbed = {
              title: 'Session error',
              color: COLORS.error,
              description: errorStr
                ? errorStr.length > DISCORD_EMBED_DESCRIPTION_MAX_LENGTH
                  ? errorStr.slice(
                      0,
                      DISCORD_EMBED_DESCRIPTION_MAX_LENGTH - ELLIPSIS_LENGTH,
                    ) + ELLIPSIS
                  : errorStr
                : undefined,
              fields: buildFields(
                filterSendFields(
                  [['sessionID', sessionID]],
                  withForcedSendParams(sendParams, [
                    'sessionID',
                    'projectID',
                    'directory',
                  ]),
                ),
              ),
            }

            if (!sessionID) return

            const mention = buildCompleteMention()

            const body: DiscordExecuteWebhookBody = {
              content: mention ? `${mention.content} Session error` : undefined,
              allowed_mentions: mention?.allowed_mentions,
              embeds: [embed],
            }

            enqueueToThread(sessionID, body)

            // フォールバック送信（メンションがある場合のみ）
            await postFallbackIfNeeded(
              {
                body,
                mention,
                sessionID,
                fallbackUrl: fallbackWebhookUrl,
                firstUserTextBySession,
                lastSessionInfo,
              },
              postDeps,
            )

            // session.errorでもワーカーを起動（旧実装のflushPendingに相当）
            startWorkerIfNeeded()

            return
          }

          case 'todo.updated': {
            const p = event.properties as any
            const sessionID = p?.sessionID as string | undefined
            if (!sessionID) return

            const embed: DiscordEmbed = {
              title: 'Todo updated',
              color: COLORS.info,
              fields: buildFields(
                filterSendFields([['sessionID', sessionID]], sendParams),
              ),
              description: buildTodoChecklist(p?.todos),
            }

            enqueueToThread(sessionID, { embeds: [embed] })

            // キューにメッセージを追加したので、ワーカーを起動して即座に処理開始
            startWorkerIfNeeded()
            return
          }

          case 'message.updated': {
            const info = (event.properties as any)?.info
            const messageID = info?.id as string | undefined
            const role = info?.role as string | undefined
            if (!messageID) return

            if (role !== 'user' && role !== 'assistant') return
            messageRoleById.set(messageID, role)

            const pendingParts = pendingTextPartsByMessageId.get(messageID)
            if (!pendingParts?.length) return

            pendingTextPartsByMessageId.delete(messageID)

            for (const part of pendingParts) {
              const sessionID = part?.sessionID
              const partID = part?.id
              if (!sessionID || !partID || part?.type !== 'text') continue

              await handleTextPart({
                part,
                role,
                sessionID,
                messageID,
                replay: true,
              })
            }

            return
          }

          case 'message.part.updated': {
            const p = event.properties as any
            const part = p?.part as any
            const sessionID = part?.sessionID as string | undefined
            const messageID = part?.messageID as string | undefined
            const partID = part?.id as string | undefined
            const type = part?.type as string | undefined
            if (!sessionID || !messageID || !partID || !type) return

            if (type === 'reasoning') return

            const role = messageRoleById.get(messageID)
            if (role !== 'assistant' && role !== 'user') {
              const list = pendingTextPartsByMessageId.get(messageID) ?? []
              list.push(part)
              pendingTextPartsByMessageId.set(messageID, list)
              return
            }
            await handleTextPart({
              part,
              role,
              sessionID,
              messageID,
            })

            return
          }

          default:
            return
        }
      } catch {
        // noop
      }
    },
    __test__: {
      queueWorker,
      persistentQueue,
    },
  }
}
;(plugin as any).__test__ = {
  buildMention,
  buildTodoChecklist,
  buildFields,
  toIsoTimestamp,
  postDiscordWebhook,
  parseSendParams,
  getTodoStatusMarker,
  postFallbackIfNeeded,
}

export default plugin
