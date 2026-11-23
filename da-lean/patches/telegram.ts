/**
 * __PRINCIPAL_NAME__ — Telegram Module (scoped DA, with identity + memory)
 *
 * Reduced from the LifeOS Pulse Telegram module (skills/LifeOS/install/LifeOS/PULSE/modules/telegram.ts).
 * Kept: grammY polling, allowlist auth, input sanitization, per-chat queued
 * processing, Claude Agent SDK session with resume, streaming edit updates,
 * conversation history within a thread, PLUS a scoped identity+memory
 * context injection (see buildContextBlock below), PLUS voice-note/audio
 * transcription (Groq Whisper, ported from the LIVE LifeOS telegram.ts —
 * the public install template this file was originally based on never had
 * it, hence the gap the first pass shipped with).
 * Cut: TELOS, PROJECTS.md active-sessions, Algorithm mode scaffolding, the
 * autonomic memory reviewer (hooks-driven, tier-gated, Telegram
 * proposal-approval UI), BM25 relevant-memory retrieval, voice OUTPUT
 * summary pipeline (Sonnet + ElevenLabs — no ElevenLabs key provisioned for
 * this tenant yet), /notify tool-use blocking, the vault-archiving branch
 * for long audio (no vault here). None of the LifeOS goal-tracking or
 * dashboard machinery exists in this container.
 *
 * Memory model (deliberately simpler than LifeOS's hot-layer + reviewer):
 * durable facts live as free-text bullets at the bottom of DA_IDENTITY.md /
 * PRINCIPAL_IDENTITY.md under a "## Memory-System Proposals" heading — the
 * model appends directly via the Edit tool when it learns something worth
 * keeping, same shape as what's already running for operador's own DA today.
 * Both files are read in full every turn (small, capped by convention, no
 * retrieval needed).
 *
 * Workspace model: `workspace_root` is a PARENT directory containing one or
 * more project repos as siblings. The
 * SDK's `cwd` points at the root; a router CLAUDE.md there tells the model
 * which subfolder to enter for a given topic, same pattern used for routing
 * between projects on the Jão side.
 *
 * Does NOT create its own HTTP server. Runs as a standalone process inside
 * the tenant container (no Pulse dashboard/observability/wiki modules).
 *
 * Billing: no ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN stripping here — this
 * tenant bills directly against a paid Anthropic API key (no Claude Code
 * subscription OAuth token for __PRINCIPAL_NAME__), unlike the LifeOS module which deletes
 * those env vars to force subscription billing.
 */

import { Bot } from "grammy"
import { query } from "@anthropic-ai/claude-agent-sdk"
import { ConversationStore, type ConversationMessage } from "./lib/conversation"
import { sanitize, analyzeForInjection } from "./lib/sanitize"
import { mdToTelegramHtml } from "./lib/telegram-format"
import { resolveSpeaker, speakerContextLine } from "./lib/identity"
import { reactionsEnabled, receiptReaction, splitReactMarker } from "./lib/reactions"
import { join } from "path"
import { appendFile, mkdir, readFile, stat } from "fs/promises"

// ── Config Interface ──

export interface TelegramConfig {
  enabled: boolean
  bot_token?: string
  allowed_users?: number[]
  max_turns?: number
  /** Aborta o turno após este silêncio REAL do SDK (rearmado a cada evento). Substitui o antigo sdk_timeout_ms de parede, que ceifava turno legítimo longo. */
  sdk_inactivity_ms?: number
  /** Rede de segurança absoluta pro turno inteiro, trabalhando ou não. */
  sdk_hard_cap_ms?: number
  edit_interval_ms?: number
  /** Ceiling on the resumed session's occupied context before starting a fresh thread (with a recap). See DEFAULT_MAX_CONTEXT_TOKENS. */
  max_context_tokens?: number
  /** cwd for the SDK session — a PARENT dir containing one or more project repos as siblings. Required. */
  workspace_root: string
  /** Dir containing DA_IDENTITY.md + PRINCIPAL_IDENTITY.md. Required. */
  identity_dir: string
  /** Destino determinístico de anexos recebidos (ex.: inbox/ de um dos repos do workspace). Opcional — sem ele, o anexo fica no tmp e o modelo decide. */
  inbox_dir?: string
  /** Display name used in the system-prompt framing and the chat log. Defaults to "Assistente". */
  da_name?: string
  /** Principal's first name, used in the same places. Defaults to "__PRINCIPAL_NAME__". */
  principal_name?: string
}

// ── Constants ──

const HOME = process.env.HOME ?? ""
const STATE_DIR = process.env.STATE_DIR ?? join(HOME, "state", "telegram")
const LOGS_DIR = process.env.LOGS_DIR ?? join(HOME, "logs", "telegram")
const MAX_TELEGRAM_LENGTH = 4096
const CURSOR = " ▌"
const STATUS_EDIT_MS = 1200 // throttle da linha de status de ferramenta (🔧)

/** Rótulo amigável (pt) do que o __DA_NAME__ está fazendo ao usar uma ferramenta —
 *  mesma ideia do tenant-d, adaptada à voz do negócio do __PRINCIPAL_NAME__. */
function toolStatusLabel(name: string): string {
  const map: Record<string, string> = {
    Read: "🔎 consultando o material…",
    Grep: "🔎 procurando nos registros…",
    Glob: "🔎 procurando…",
    LS: "🔎 vendo o que tem…",
    Bash: "⏳ conferindo…",
    Write: "✍️ guardando…",
    Edit: "✍️ anotando…",
    MultiEdit: "✍️ anotando…",
    WebFetch: "🌐 buscando lá fora…",
    WebSearch: "🌐 pesquisando…",
  }
  return map[name] ?? "⏳ um instante…"
}
const IDLE_TIMEOUT_MS = 60 * 60 * 1000 // 1 hour — gap of silence that resets the SDK session + drops prior history injection
// A `--resume`d session's context only grows turn over turn (no compaction) —
// left unchecked it eventually hits the model's hard context ceiling mid-turn.
// 180k splits the difference between the "150k or 200k" range models actually use.
const DEFAULT_MAX_CONTEXT_TOKENS = 180_000
const RECAP_MAX_WORDS = 120
const RECAP_TIMEOUT_MS = 20_000          // boundary event, not every turn — can afford more patience
const CONTEXT_CACHE_TTL_MS = 60_000
const TZ = process.env.TZ ?? "America/Sao_Paulo"

// Groq Whisper — transcription of inbound voice notes / audio files. No
// `language` field on the request (unlike the LifeOS module, which pins
// "pt"): whisper-large-v3-turbo auto-detects reliably, o que importa em
// tenant cujo principal fala mais de um idioma. Telegram voice notes are
// OGG/Opus, which Groq accepts directly.
const GROQ_API_KEY = process.env.GROQ_API_KEY ?? ""
const GROQ_TRANSCRIPTION_URL = "https://api.groq.com/openai/v1/audio/transcriptions"
const GROQ_WHISPER_MODEL = "whisper-large-v3-turbo"
const GROQ_FETCH_TIMEOUT_MS = 120_000
const MAX_DOCUMENT_BOT_API_BYTES = 20 * 1024 * 1024  // teto da própria Bot API do Telegram pra download

const AUDIO_MIME_BY_EXT: Record<string, string> = {
  flac: "audio/flac", mp3: "audio/mpeg", mpeg: "audio/mpeg", mpga: "audio/mpeg",
  m4a: "audio/mp4", mp4: "audio/mp4", ogg: "audio/ogg", oga: "audio/ogg",
  opus: "audio/ogg", wav: "audio/wav", webm: "audio/webm",
}

// ── Module State ──

let bot: Bot | null = null
let conversationStore: ConversationStore | null = null
let startedAt = 0
let messagesReceived = 0
let messagesResponded = 0
let lastSessionId: string | undefined
let activeConfig: TelegramConfig | null = null

// Idle-session-boundary state — see LifeOS module for the full rationale.
// Single-chat assumption: module-global, matching allowed_users being a
// single-principal allowlist for this tenant.
let lastMessageAt: number | null = null
let threadStartedAt: number = 0
// Last observed occupied-context size (input+cache tokens of the last SDK
// call) — used only for the context-size session boundary. Null until the
// first turn completes; reset to null on either boundary.
let lastContextTokens: number | null = null

let cachedContext: { text: string; builtAt: number; mtimes: Record<string, number> } | null = null

// ── Fila por chat (portado do tenant-d, 2026-09-21) ──
//
// Antes: um `processing` global — mensagem que chegasse no meio de um turno
// levava "Ainda processando sua mensagem anterior. Um instante." e MORRIA. O
// __PRINCIPAL_NAME__ mandava três coisas seguidas e duas sumiam. Agora o handler só filtra e
// ENFILEIRA (volta na hora, o loop do grammY nunca espera um turno); o dreno
// roda destacado, um turno por vez por chat, e o que chegou colado (texto +
// pedido, duas encaminhadas, álbum de fotos) vira UM turno só.
const BATCH_SETTLE_MS = 1500           // espera a rajada assentar antes de rodar o turno
const MAX_QUOTE_CHARS = 3500           // teto do texto citado num reply — o original inteiro costuma ser o pedido
const MAX_QUOTE_BOT_CHARS = 500        // reply a mensagem do próprio bot: só um trecho (a resposta já está no histórico)

type PendingMsg = { ctx: any; contexto: string }
const pendingByChat = new Map<number, PendingMsg[]>()
const processingByChat = new Map<number, boolean>()
const settleTimerByChat = new Map<number, ReturnType<typeof setTimeout>>()

// ── Logging ──

function log(level: "info" | "warn" | "error", msg: string, data?: unknown) {
  const entry = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    component: "telegram",
    msg,
    ...(data ? { data } : {}),
  })
  console.log(entry)
}

// ── Chat Log ──

async function appendChatLog(principalName: string, daName: string, userMsg: string, botMsg: string) {
  const chatLogPath = join(LOGS_DIR, "chat-log.md")
  const ts = new Date().toLocaleString("pt-BR", {
    timeZone: TZ,
    day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit",
  })
  const entry = `\n### ${ts}\n**${principalName}:** ${userMsg}\n\n**${daName}:** ${botMsg}\n\n---\n`
  await appendFile(chatLogPath, entry).catch(() => {})
}

// ── Voice / Audio Transcription (Groq Whisper) ──

/**
 * Transcreve um áudio via Groq Whisper. Sem `language` fixo — auto-detecta,
 * com auto-detecção de idioma. Falha aqui vira aviso no
 * chat, nunca derruba o bot.
 */
async function transcribeGroq(audio: Uint8Array, filename: string): Promise<string> {
  if (!GROQ_API_KEY) throw new Error("GROQ_API_KEY ausente no ambiente")
  const ext = filename.slice(filename.lastIndexOf(".") + 1).toLowerCase()
  const type = AUDIO_MIME_BY_EXT[ext] ?? "application/octet-stream"
  const form = new FormData()
  form.append("file", new Blob([audio], { type }), filename)
  form.append("model", GROQ_WHISPER_MODEL)
  form.append("response_format", "json")
  const res = await fetch(GROQ_TRANSCRIPTION_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${GROQ_API_KEY}` },
    body: form,
    signal: AbortSignal.timeout(GROQ_FETCH_TIMEOUT_MS),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => "")
    throw new Error(`Groq Whisper ${res.status}: ${detail.slice(0, 200)}`)
  }
  const parsed = (await res.json()) as { text?: string }
  return String(parsed.text ?? "").trim()
}

/**
 * Baixa a voice note / arquivo de áudio da mensagem do Telegram pra um path
 * em /tmp e devolve metadados. Cobre `voice` (OGG/Opus) e `audio` (arquivo).
 * Null se a mensagem não tiver áudio.
 */
async function downloadTelegramAudio(
  ctx: any,
  token: string,
): Promise<{ path: string; filename: string } | null> {
  const msg = ctx.message ?? {}
  let fileId: string | undefined
  let srcName = ""
  if (msg.voice) {
    fileId = msg.voice.file_id
    srcName = "voice.ogg"
  } else if (msg.audio) {
    fileId = msg.audio.file_id
    srcName = msg.audio.file_name || "audio.mp3"
  } else if (String(msg.document?.mime_type ?? "").startsWith("audio/")) {
    fileId = msg.document.file_id
    srcName = msg.document.file_name || "audio"
  }
  if (!fileId) return null
  try {
    const file = await ctx.api.getFile(fileId)
    if (!file.file_path) return null
    const res = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`)
    if (!res.ok) return null
    const buf = new Uint8Array(await res.arrayBuffer())
    const tgExt = String(file.file_path).split(".").pop()?.toLowerCase()
    const ext = tgExt && AUDIO_MIME_BY_EXT[tgExt] ? tgExt : (srcName.split(".").pop() || "ogg")
    // Groq valida pela EXTENSÃO do nome — "oga" (como o Telegram nomeia voice
    // notes OGG/Opus) não está na lista aceita, normaliza pra "ogg".
    const groqExt = ext === "oga" ? "ogg" : ext
    const path = `/tmp/__TENANT__-audio-${msg.message_id}.${ext}`
    await Bun.write(path, buf)
    return { path, filename: `audio.${groqExt}` }
  } catch (err) {
    log("warn", "downloadTelegramAudio failed", { error: String(err).slice(0, 200) })
    return null
  }
}

/**
 * Baixa a maior variante de uma foto (ou document com mime image/*) pra um
 * path temporário, pro __DA_NAME__ ler com Read (visão através dos olhos do SDK).
 */
async function downloadTelegramImage(ctx: any, token: string): Promise<string | null> {
  try {
    const photos = ctx.message?.photo
    let fileId: string | undefined
    if (Array.isArray(photos) && photos.length) fileId = photos[photos.length - 1]?.file_id
    else if (String(ctx.message?.document?.mime_type ?? "").startsWith("image/")) fileId = ctx.message.document.file_id
    if (!fileId) return null
    const file = await ctx.api.getFile(fileId)
    if (!file.file_path) return null
    const res = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`)
    if (!res.ok) return null
    const buf = new Uint8Array(await res.arrayBuffer())
    const ext = String(file.file_path).split(".").pop() || "jpg"
    const path = `/tmp/__TENANT__-img-${ctx.message.message_id}.${ext}`
    await Bun.write(path, buf)
    return path
  } catch (err) {
    log("warn", "downloadTelegramImage failed", { error: String(err).slice(0, 200) })
    return null
  }
}

/**
 * Baixa um `document` genérico do Telegram (PDF, CSV, planilha, JSON, zip,
 * .md...) pra um path temporário, preservando o `file_name` original.
 */
async function downloadTelegramDocument(
  ctx: any,
  token: string,
): Promise<{ path: string; filename: string } | null> {
  try {
    const doc = ctx.message?.document
    if (!doc?.file_id) return null
    const file = await ctx.api.getFile(doc.file_id)
    if (!file.file_path) return null
    const res = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`)
    if (!res.ok) return null
    const buf = new Uint8Array(await res.arrayBuffer())
    const originalName = String(doc.file_name || "arquivo")
    const ext = (originalName.includes(".") ? originalName.split(".").pop() : String(file.file_path).split(".").pop()) || "bin"
    const path = `/tmp/__TENANT__-doc-${ctx.message.message_id}.${ext}`
    await Bun.write(path, buf)
    return { path, filename: originalName }
  } catch (err) {
    log("warn", "downloadTelegramDocument failed", { error: String(err).slice(0, 200) })
    return null
  }
}

// ── Continuity Recap (session/context boundaries) ──

function tidyRecap(raw: string): string {
  let s = raw.trim()
  s = s.replace(/^["'`]+|["'`]+$/g, "")
  s = s.replace(/^(resumo|recap|summary)[:\-—]\s*/i, "")
  s = s.replace(/\s+/g, " ").trim()
  const words = s.split(/\s+/)
  if (words.length > RECAP_MAX_WORDS) {
    s = words.slice(0, RECAP_MAX_WORDS).join(" ").replace(/[,;:\s]+$/, "") + "…"
  }
  return s
}

/**
 * Resume uma thread abandonada num recap curto quando um boundary de sessão
 * dispara (idle ou context-size) — pra sessão nova não ser amnésia total.
 * Sem Inference.ts (não existe nesse container escopado) — usa uma chamada
 * query() própria, mínima (sem tools, 1 turno), separada da conversa
 * principal. Aguardado (não fire-and-forget): o turno que disparou o reset
 * PRECISA do recap pronto antes de montar o prompt. Falha/timeout devolve
 * null — nunca bloqueia o reset em si (fail open).
 */
async function summarizeThreadForRecap(daName: string, principalName: string, history: ConversationMessage[]): Promise<string | null> {
  if (history.length === 0) return null
  const transcript = history
    .map(m => `${m.role === "user" ? principalName : daName}: ${m.content}`)
    .join("\n")
    .slice(-40_000) // não deixa uma thread abandonada já enorme travar o próprio resumo

  const systemPrompt = [
    `Você é ${daName}, assistente de ${principalName}.`,
    "A conversa abaixo é uma thread prestes a ser abandonada (boundary de sessão — idle ou limite de contexto). Escreva um recap CURTO de continuidade pra a sessão seguinte não começar do zero.",
    "SEMPRE em português do Brasil, independente do idioma da transcrição.",
    "3 a 5 frases curtas: do que se falava, o que foi decidido/feito, o que ainda está em aberto.",
    "Prosa simples. Sem markdown, sem headers, sem bullets, sem aspas envolvendo a resposta.",
    `Teto: ${RECAP_MAX_WORDS} palavras.`,
    "Devolva só o recap — sem preâmbulo tipo 'Aqui está o resumo'.",
  ].join("\n")

  try {
    const conversation = query({
      prompt: transcript,
      options: {
        model: process.env.CLAUDE_MODEL ?? "claude-sonnet-5",
        maxTurns: 1,
        tools: [],
        systemPrompt,
      } as any,
    })
    const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), RECAP_TIMEOUT_MS))
    const collect = (async (): Promise<string | null> => {
      let out = ""
      for await (const message of conversation) {
        const msg = message as any
        if (msg.type === "result" && msg.subtype === "success" && msg.result) out = msg.result
      }
      return out || null
    })()
    const result = await Promise.race([collect, timeout])
    if (!result) {
      log("warn", "summarizeThreadForRecap: sem resultado (timeout ou vazio), pulando recap")
      return null
    }
    return tidyRecap(result)
  } catch (err) {
    log("warn", "summarizeThreadForRecap: falhou, pulando recap", { error: String(err).slice(0, 200) })
    return null
  }
}

// ── Identity + Memory Context Injection ──
//
// Trimmed replacement for the LifeOS module's buildPaiContextBlock(): reads
// two files in full (DA_IDENTITY.md, PRINCIPAL_IDENTITY.md — each ending in
// a free-text "## Memory-System Proposals" section) instead of four
// TELOS/PROJECTS-aware sources plus a hot-layer memory subsystem. Cached
// with a 60s TTL + per-file mtime invalidation, same mechanism as upstream,
// so a memory append the model just made is visible on the very next turn.

function identityPaths(identityDir: string) {
  return {
    da: join(identityDir, "DA_IDENTITY.md"),
    principal: join(identityDir, "PRINCIPAL_IDENTITY.md"),
  }
}

async function buildContextBlock(identityDir: string): Promise<string> {
  const paths = identityPaths(identityDir)
  const mtimes: Record<string, number> = {}
  await Promise.all(Object.values(paths).map(async (p) => {
    try {
      const st = await stat(p)
      mtimes[p] = st.mtimeMs
    } catch {
      mtimes[p] = 0
    }
  }))

  if (cachedContext) {
    const age = Date.now() - cachedContext.builtAt
    const mtimesUnchanged = Object.entries(mtimes).every(([k, v]) => cachedContext!.mtimes[k] === v)
    if (age < CONTEXT_CACHE_TTL_MS && mtimesUnchanged) {
      return cachedContext.text
    }
  }

  const readSafe = async (p: string, label: string): Promise<string> => {
    try {
      return (await readFile(p, "utf8")).trim()
    } catch (err) {
      log("warn", "context-block: file unavailable", { p, error: String(err).slice(0, 120) })
      return `(${label} indisponível em disco)`
    }
  }

  const [daIdentity, principalIdentity] = await Promise.all([
    readSafe(paths.da, "DA_IDENTITY"),
    readSafe(paths.principal, "PRINCIPAL_IDENTITY"),
  ])

  const today = new Date().toLocaleString("pt-BR", {
    timeZone: TZ,
    weekday: "long", year: "numeric", month: "long", day: "numeric",
    hour: "numeric", minute: "2-digit",
  })

  const block = [
    "## CONTEXTO (atualizado a cada turno, não narre este cabeçalho)",
    "",
    `**Agora:** ${today} (${TZ})`,
    "",
    "### Sobre você (identidade + memória do que você já aprendeu)",
    daIdentity,
    "",
    "### Sobre quem você atende",
    principalIdentity,
  ].join("\n")

  cachedContext = { text: block, builtAt: Date.now(), mtimes }
  return block
}

// ── Contexto de reply / encaminhamento ──
//
// Portado do tenant-d (2026-09-21). Antes o reply virava `[Respondendo a:
// "<300 chars>"]` — sem autor, cortado cego no meio da frase, e mensagem
// ENCAMINHADA chegava sem nenhuma pista de origem (o principal encaminha conversa
// de parceiro o tempo todo). Agora: autor nomeado, origem da encaminhada, e
// teto de 3500 chars porque o texto citado normalmente É o pedido.
function messageContext(msg: any, botId: number, daName: string): string {
  const nome = (u: any) => [u?.first_name, u?.last_name].filter(Boolean).join(" ")
  const linhas: string[] = []

  const o = msg.forward_origin
  if (o) {
    const origem = o.type === "user" ? nome(o.sender_user)
      : o.type === "hidden_user" ? String(o.sender_user_name ?? "")
      : String(o.chat?.title ?? o.sender_chat?.title ?? "")
    linhas.push(`[mensagem encaminhada${origem ? ` de ${origem}` : ""}]`)
  }

  const replied = msg.reply_to_message
  if (replied || msg.quote) {
    const doBot = replied?.from?.id === botId
    const autor = !replied ? "outra conversa" : doBot ? `você (${daName})` : nome(replied.from) || "alguém"
    const citado = String(msg.quote?.text ?? replied?.text ?? replied?.caption ?? "")
    if (citado) {
      const teto = doBot ? MAX_QUOTE_BOT_CHARS : MAX_QUOTE_CHARS
      const trecho = citado.length > teto ? `${citado.slice(0, teto)}…` : citado
      linhas.push(`[respondendo a ${msg.quote ? "um trecho da " : ""}mensagem de ${autor}:\n"""\n${trecho}\n"""]`)
    } else if (replied) {
      linhas.push(`[respondendo a uma mensagem de ${autor} sem texto (mídia)]`)
    }
  }
  return linhas.join("\n")
}

// ── Exports ──

/**
 * Start the Telegram bot polling loop.
 * Runs forever until stopTelegram() is called or the container is stopped.
 */
export async function startTelegram(config: TelegramConfig): Promise<void> {
  if (!config.enabled) {
    log("info", "Telegram module disabled")
    return
  }

  const token = config.bot_token ?? process.env.TELEGRAM_BOT_TOKEN
  if (!token) {
    log("error", "No bot token — set bot_token in config or TELEGRAM_BOT_TOKEN in env")
    return
  }

  const workspaceRoot = config.workspace_root ?? process.env.WORKSPACE_ROOT
  if (!workspaceRoot) {
    log("error", "No workspace_root configured — this bot needs a parent dir containing the project repos to cwd into")
    return
  }

  const identityDir = config.identity_dir ?? process.env.IDENTITY_DIR
  if (!identityDir) {
    log("error", "No identity_dir configured — needs DA_IDENTITY.md + PRINCIPAL_IDENTITY.md")
    return
  }

  const inboxDir = config.inbox_dir ?? process.env.INBOX_DIR ?? ""
  // Roster de interlocutores (quem fala com o __DA_NAME__): dono / arquiteto / visitante.
  // Semeado pelo entrypoint no identity dir; editável a quente (cache por mtime).
  const rosterPath = join(identityDir, "roster.md")

  const allowedUsers = new Set(
    config.allowed_users?.length
      ? config.allowed_users
      : (process.env.TELEGRAM_ALLOWED_USERS ?? "")
          .split(",")
          .map(s => s.trim())
          .filter(Boolean)
          .map(Number)
  )

  if (allowedUsers.size === 0) {
    log("error", "No allowed users configured")
    return
  }

  if (!GROQ_API_KEY) {
    log("warn", "GROQ_API_KEY ausente — voice notes/áudio não serão transcritos (mensagens de texto seguem normais)")
  }

  const daName = config.da_name ?? "Assistente"
  const principalName = config.principal_name ?? "__PRINCIPAL_NAME__"
  const maxTurns = config.max_turns ?? 25
  // Watchdog de INATIVIDADE no lugar do teto de parede (portado do bot vivo,
  // 2026-07-20): o timeout fixo ceifava turno LEGÍTIMO longo (refatoração
  // grande, pipeline de arquivos). Agora aborta só após silêncio real do SDK,
  // com um hard cap absoluto como rede de segurança.
  const sdkInactivityMs = config.sdk_inactivity_ms ?? 180_000
  const sdkHardCapMs = config.sdk_hard_cap_ms ?? 900_000
  const editIntervalMs = config.edit_interval_ms ?? 800
  const maxContextTokens = config.max_context_tokens ?? DEFAULT_MAX_CONTEXT_TOKENS

  // Ensure directories
  await mkdir(STATE_DIR, { recursive: true })
  await mkdir(LOGS_DIR, { recursive: true })

  // Initialize conversation store
  conversationStore = new ConversationStore(join(STATE_DIR, "conversations.json"))
  await conversationStore.load()

  // Create bot
  activeConfig = config
  startedAt = Date.now()
  messagesReceived = 0
  messagesResponded = 0
  pendingByChat.clear()
  processingByChat.clear()
  settleTimerByChat.clear()
  lastSessionId = undefined
  lastMessageAt = null
  threadStartedAt = Date.now()

  bot = new Bot(token)

  // Auth middleware
  bot.use(async (ctx, next) => {
    const userId = ctx.from?.id
    if (!userId || !allowedUsers.has(userId)) {
      log("warn", "Rejected message from unauthorized user", { userId, username: ctx.from?.username })
      return
    }
    await next()
  })

  /**
   * Shared pipeline for any inbound message once it's been reduced to plain
   * text (typed, or transcribed from voice/audio). Sanitizes, runs the SDK
   * turn, streams edits, persists history.
   */
  async function processMessage(ctx: any, sanitized: string): Promise<void> {
    const userId = ctx.from.id
    const chatId = ctx.chat.id

    // Quem fala neste turno (dono / arquiteto / visitante) — o prompt ajusta
    // tom e permissões ao papel. `principalName` segue sendo o DONO do negócio
    // (__PRINCIPAL_NAME__, sujeito dos arquivos e do conteúdo); o falante pode não ser ele.
    const fallbackNome = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(" ") || String(userId)
    const speaker = resolveSpeaker(userId, fallbackNome, rosterPath)

    log("info", "Turn starting", { userId, chatId, textLength: sanitized.length, speaker: speaker.nome, papel: speaker.papel })

    const startTime = Date.now()
    const now = Date.now()

    // Capturado ANTES de qualquer branch de reset sobrescrever threadStartedAt
    // — é o que permite achar o histórico da thread abandonada depois.
    const abandonedThreadStartedAt = threadStartedAt
    let recap: string | null = null

    // Idle-session boundary — same mechanism as the LifeOS module: a gap
    // longer than IDLE_TIMEOUT_MS clears the SDK session and starts a fresh
    // thread. conversations.json is untouched — only the history filter below
    // changes what gets replayed into the prompt. Durable facts survive this
    // boundary regardless, because they live in the identity files, not in
    // conversation history.
    const isIdleReset = lastMessageAt !== null && (now - lastMessageAt) > IDLE_TIMEOUT_MS
    if (isIdleReset) {
      const prevSessionId = lastSessionId
      log("info", "thread boundary — fresh session", {
        idleMs: now - lastMessageAt!,
        prevSessionId,
        newThreadStartedAt: now,
      })
      lastSessionId = undefined
      lastContextTokens = null
      threadStartedAt = now
    }

    // Context-size boundary: mesmo sem gap de silêncio, uma sessão --resume
    // só cresce de contexto turno a turno (sem compactação) — sem isso, cedo
    // ou tarde estoura o teto de contexto do modelo no meio de um turno.
    // Em vez de compactar (degrada qualidade), começa sessão nova e avisa
    // __PRINCIPAL_NAME__ antes de responder.
    const isContextReset = !isIdleReset && lastContextTokens !== null && lastContextTokens >= maxContextTokens
    if (isContextReset) {
      const prevSessionId = lastSessionId
      const tokensAtReset = lastContextTokens!
      log("info", "context-size boundary — fresh session", {
        contextTokens: tokensAtReset, threshold: maxContextTokens, prevSessionId, newThreadStartedAt: now,
      })
      lastSessionId = undefined
      lastContextTokens = null
      threadStartedAt = now
      await ctx.reply(
        `🔄 Nosso papo cresceu bastante (~${Math.round(tokensAtReset / 1000)}k tokens de contexto) — comecei uma sessão nova em vez de deixar comprimir, porque compactação degrada o contexto. Se precisar de algo específico de antes, me lembra que eu busco.`,
      ).catch(() => {})
    }

    // Recap de continuidade: em QUALQUER boundary, resume a thread abandonada
    // pra sessão nova não ser amnésia total. Aguardado — este turno É o
    // primeiro da thread nova, o recap precisa estar pronto antes do prompt.
    if (isIdleReset || isContextReset) {
      const abandonedHistory = conversationStore!.getHistory()
        .filter(m => m.timestamp >= abandonedThreadStartedAt && m.timestamp < now)
      recap = await summarizeThreadForRecap(daName, principalName, abandonedHistory)
      if (recap) log("info", "continuity recap generated", { wordCount: recap.split(/\s+/).length })
    }

    try {
      // A reação de CHEGADA já foi posta no handler, pelo TIPO do que veio
      // (⚡ urgente · ✍ áudio · 👀 anexo · 🤔 pergunta · 🙏 agradecimento). A
      // final, pelo que aconteceu no turno, quem escolhe é o modelo (marcador
      // REACT, tratado no fim desta função).
      await ctx.api.sendChatAction(chatId, "typing").catch(() => {})

      const contextBlock = await buildContextBlock(identityDir)

      const history = conversationStore!.getHistory()
        .filter(m => m.timestamp >= threadStartedAt)
      let prompt = sanitized
      if (history.length > 0) {
        const historyText = history
          .slice(-10)
          .map(m => `${m.role === "user" ? principalName : daName}: ${m.content}`)
          .join("\n")
        prompt = `Conversa anterior:\n${historyText}\n\nNova mensagem de ${speaker.nome}: ${sanitized}`
      } else if (recap) {
        prompt = `[Sessão anterior encerrada — resumo pra retomar: ${recap}]\n\nNova mensagem de ${speaker.nome}: ${sanitized}`
      }

      // Declarado aqui (antes do sdkOptions) pra poder ser usado como
      // abortController — sem isso, um subprocess travado nunca libera
      // `processing`, travando o bot pra sempre (bug real, corrigido 2026-07-16
      // no telegram.ts vivo; `.abort()` sozinho só marca uma flag que o loop
      // só checa ENTRE mensagens — se o processo trava sem nunca emitir mais
      // nada, essa flag nunca é revisitada).
      const timeoutController = new AbortController()

      const sdkOptions: Record<string, unknown> = {
        cwd: workspaceRoot,
        abortController: timeoutController,
        tools: { type: "preset", preset: "claude_code" },
        // "project" picks up workspace_root's own CLAUDE.md (the multi-repo
        // router) — no "local" needed, there's no LifeOS Algorithm/mode
        // scaffolding in this workspace to skip.
        settingSources: ["user", "project"],
        // Tenant de outra pessoa, billing via API key paga (não assinatura) —
        // Sonnet 5 por padrão corta custo do Opus sem perder qualidade de
        // conversa, mesmo raciocínio aplicado ao tenant-a. Configurável.
        model: process.env.CLAUDE_MODEL ?? "claude-sonnet-5",
        maxTurns,
        includePartialMessages: true,
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          append: `\n\n${contextBlock}\n\n## MODO TELEGRAM — COMO VOCÊ RESPONDE

Você é ${daName}, respondendo pelo Telegram (provavelmente celular). Mais de uma pessoa pode falar com você — veja "Quem está falando agora" logo abaixo e ajuste tom e permissões ao papel dela. O interlocutor pode escrever em português OU francês — responda no mesmo idioma da mensagem.

### Quem está falando agora
${speakerContextLine(speaker, principalName)}
- Endereço a pessoa pelo nome dela (acima), não presuma que é sempre ${principalName}.
- "${principalName}" neste prompt = o DONO do negócio (sujeito dos arquivos e do conteúdo). Nem todo mundo que fala com você é ele.

### Workspace multi-projeto
O CLAUDE.md na raiz do seu cwd lista os projetos disponíveis (repos-irmãos, cada um com seu próprio CLAUDE.md/CONTEXT.md). Identifique de qual projeto a mensagem trata, entre na pasta certa e siga o roteamento dela. Não misture regras/identidade de um projeto com outro. **Leia os arquivos de verdade antes de responder sobre preços, parceiros ou detalhes do negócio** — não responda de memória/conhecimento geral quando a resposta certa está num arquivo do workspace.

### Memória — isso É funcionalidade sua, use
As seções "Sobre você" e "Sobre quem você atende" acima incluem, no final de cada uma, um "## Memory-System Proposals" — fatos duráveis que você já aprendeu (nome, papel, relação, preferência, regra). Os arquivos ficam em \`${identityDir}/DA_IDENTITY.md\` (fatos sobre você mesmo) e \`${identityDir}/PRINCIPAL_IDENTITY.md\` (fatos sobre ${principalName}/o negócio) — **esse caminho é fixo, fora do workspace de projetos** (não confunda com o cwd, que é ${workspaceRoot}). Quando aprender algo durável e que vale lembrar entre sessões — uma preferência de ${principalName}, uma correção, uma regra operacional sua — use a ferramenta Edit no arquivo certo, acrescentando UMA linha nessa seção, no formato:
\`- <fato, uma frase, sem enrolação> <!-- applied: ${new Date().toISOString()} -->\`
Faça isso na hora que aprender, sem esperar pedido. Não registre conversa fiada — só o que é durável e faria diferença esquecer.

### Como escrever
- Direto ao ponto. Sem "Ótima pergunta", sem preâmbulo.
- Respostas curtas — leitura de celular, não parede de texto.
- Sem blocos de código, a menos que ${principalName} peça.
- Registro conforme o papel de quem fala (ver "Quem está falando agora"): com o DONO ou um VISITANTE, nada de jargão de git/programação — "commit", "push", "repositório", "branch" não são assunto; diga "salvei localmente", "sincronizei", "fiz backup" (a mecânica de versionamento é sua, por baixo do pano). Com o ARQUITETO, pode falar de git/sistema/manutenção sem cortina.
- Perguntas a ${principalName} vão em TEXTO SIMPLES dentro da sua resposta — a ferramenta interativa AskUserQuestion não existe nesta superfície (chamá-la congela o turno) e está bloqueada.

### Fechar com reação (opcional)
Quando a mensagem chega, o sistema já reage sozinho pra dizer "recebi" (⚡ urgente, ✍ áudio, 👀 anexo, 🤔 pergunta, 🙏 agradecimento). Se no fim do turno algo concreto aconteceu, você pode TROCAR essa reação fechando a resposta com uma linha só, no fim:
REACT:<emoji>
Use pelo que DE FATO aconteceu: ✍ (guardei/anotei) · 👌 (combinado) · 👍 (feito) · 🎉 🏆 (conquista) · 🤝 (fechado com alguém) · 🤔 (fiquei em dúvida) · 🙏 (agradecimento) · 😢 (deu ruim). Regras: a linha do marcador é a ÚLTIMA e vem sozinha; o texto da resposta vem normal antes dela; nunca responda pergunta só com reação; e se nada específico aconteceu, não feche com reação nenhuma — a de chegada já basta.

### Várias mensagens de uma vez
Quando chegam várias mensagens coladas, elas vêm no MESMO turno, numeradas no topo. Leia todas antes de responder e trate como uma conversa só — uma resposta, não uma por mensagem.

### O que fazer
- Use as ferramentas para ler/escrever nos arquivos do workspace conforme o CONTEXT.md do projeto relevante.
- Depois de editar qualquer arquivo do workspace, rode \`git add -A && git commit -m "<mensagem curta>"\` na pasta do projeto — cada pasta do workspace já é um repo git configurado com push. Versionar é parte do seu trabalho, não opcional.
- Edições de conteúdo (knowledge-base, propostas, posts) sempre passam por revisão de ${principalName} antes de ir pra frente — o sistema não publica nada sozinho. Comitar/empurrar pro GitHub não é "publicar pro cliente", é só guardar o histórico.
- Se não souber algo, diga isso em uma frase, sem enrolar.`,
        },
        // TRIM de contexto (portado 2026-07-20): esconde o catálogo de skills
        // do harness (~11k tokens/sessão quando existe) — este bot não invoca
        // skills; arquivos seguem alcançáveis via Read se preciso.
        skills: [],
        // AskUserQuestion é UI de terminal interativo — no Telegram não existe
        // essa UI, a chamada trava esperando uma resposta que nunca chega e o
        // turno congela (bug confirmado no bot vivo, 2026-07-20). Fora do tool
        // set; pergunta vai em texto simples na própria resposta.
        disallowedTools: ["AskUserQuestion"],
        // Headless: sem UI de permissão no Telegram. Explícito desde o SDK
        // 0.3.x pra não depender de default que muda entre versões. SEM
        // canUseTool aqui: sob bypassPermissions o SDK 0.3 nunca o consulta
        // (warning CLAUDE_SDK_CAN_USE_TOOL_SHADOWED em todo turno) — o
        // travamento do Edit era exatamente a falta disso (SDK esperando
        // aprovação interativa que nunca chega em container headless); o
        // bloqueio real do AskUserQuestion é o disallowedTools acima.
        permissionMode: "bypassPermissions",
      }

      if (lastSessionId) {
        sdkOptions.resume = lastSessionId
      }

      const conversation = query({ prompt, options: sdkOptions as any })

      let fullText = ""
      let messageId: number | null = null
      let lastEditTime = 0
      let lastStatusTime = 0
      // Tamanho do prompt DESTE call (input+cache tokens) — sinal honesto pro
      // context-size boundary. Separado do usage agregado do `result` (que
      // soma toda sub-call de tool-use do turno e estoura em turnos com
      // muitas ferramentas).
      let lastCallInputTokens = 0

      // Dois gatilhos de abort (portado do bot vivo, 2026-07-20, no lugar do
      // teto de parede único):
      // (1) inatividade — rearmado a cada evento do SDK; dispara só em silêncio
      //     real (subprocesso morto), nunca em turno trabalhando;
      // (2) hard cap — rede de segurança absoluta pro turno inteiro.
      let turnAbortReason: "inactivity" | "hardcap" | null = null
      let inactivityTimer: ReturnType<typeof setTimeout> | undefined
      const armInactivity = () => {
        if (inactivityTimer) clearTimeout(inactivityTimer)
        inactivityTimer = setTimeout(() => {
          turnAbortReason = "inactivity"
          timeoutController.abort()
        }, sdkInactivityMs)
      }
      armInactivity()
      const hardCapTimer = setTimeout(() => {
        turnAbortReason = "hardcap"
        timeoutController.abort()
      }, sdkHardCapMs)

      try {
        for await (const message of conversation) {
          // Qualquer evento yielded pelo SDK = sinal de vida → rearma o watchdog.
          armInactivity()
          if (timeoutController.signal.aborted) break

          const msg = message as any

          if (msg.type === "system" && msg.subtype === "init" && msg.session_id) {
            lastSessionId = msg.session_id
            log("info", "Session initialized", { sessionId: lastSessionId })
          }

          if (msg.type === "stream_event" && msg.event?.type === "content_block_delta" &&
              msg.event?.delta?.type === "text_delta" && msg.event.delta.text) {
            fullText += msg.event.delta.text
          }

          // Marca de processamento de ferramenta (🔧) — mostra o que o __DA_NAME__
          // está fazendo ENQUANTO o texto real não começou. Quando o primeiro
          // delta de texto chega, o branch de edição abaixo assume a mesma
          // mensagem viva e o status para de aparecer (condição `!fullText`).
          if (msg.type === "stream_event" && msg.event?.type === "content_block_start" &&
              msg.event.content_block?.type === "tool_use" && !fullText) {
            const nowS = Date.now()
            if (nowS - lastStatusTime >= STATUS_EDIT_MS) {
              const label = toolStatusLabel(String(msg.event.content_block.name ?? ""))
              try {
                if (!messageId) {
                  const sent = await ctx.reply(label)
                  messageId = sent.message_id
                } else {
                  await ctx.api.editMessageText(chatId, messageId, label).catch(() => {})
                }
                lastStatusTime = nowS
              } catch { /* status é best-effort */ }
            }
          }

          if (msg.type === "assistant" && Array.isArray(msg.message?.content)) {
            for (const block of msg.message.content) {
              if (block.type === "text" && block.text) {
                if (!fullText) fullText = block.text
              }
            }
            const u = msg.message?.usage
            if (u) {
              lastCallInputTokens =
                (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0)
            }
          }

          if (msg.type === "result") {
            if (msg.subtype === "success" && msg.result) {
              fullText = msg.result
            }
            if (msg.session_id) lastSessionId = msg.session_id
            const aggregateUsage = msg.usage
              ? (msg.usage.input_tokens ?? 0) + (msg.usage.cache_creation_input_tokens ?? 0) + (msg.usage.cache_read_input_tokens ?? 0)
              : 0
            const modelCtx = msg.modelUsage
              ? Math.max(0, ...Object.values(msg.modelUsage as Record<string, any>).map((m: any) => m?.contextWindow ?? 0))
              : 0
            lastContextTokens = lastCallInputTokens > 0 ? lastCallInputTokens : modelCtx > 0 ? modelCtx : aggregateUsage
            log("info", "SDK session complete", {
              durationMs: Date.now() - startTime,
              numTurns: msg.num_turns,
              cost: msg.total_cost_usd,
              sessionId: lastSessionId,
              contextTokens: lastContextTokens,
            })
          }

          const now2 = Date.now()
          if (fullText && now2 - lastEditTime >= editIntervalMs) {
            const displayText = fullText.slice(0, MAX_TELEGRAM_LENGTH - 10) + CURSOR
            try {
              if (!messageId) {
                const sent = await ctx.reply(displayText)
                messageId = sent.message_id
              } else {
                await ctx.api.editMessageText(chatId, messageId, displayText).catch(() => {})
              }
              lastEditTime = now2
            } catch { /* edit failures are non-critical */ }
          }
        }
      } finally {
        if (inactivityTimer) clearTimeout(inactivityTimer)
        clearTimeout(hardCapTimer)
      }

      if (!fullText) {
        if (timeoutController.signal.aborted) {
          if (turnAbortReason === "hardcap") {
            const mins = Math.round(sdkHardCapMs / 60_000)
            fullText = `Esse turno passou do teto absoluto de ${mins} minutos e eu cortei por segurança. Se era um trabalho grande de verdade, quebra em partes que eu vou entregando por etapa.`
            log("error", "SDK turn hit hard cap with no text", { sdkHardCapMs, elapsedMs: Date.now() - startTime })
          } else {
            const secs = Math.round(sdkInactivityMs / 1000)
            fullText = `O processo ficou ${secs}s em silêncio total do meu lado — sinal de travamento real, então cortei. Manda de novo que eu retomo.`
            log("error", "SDK turn aborted on inactivity with no text", { sdkInactivityMs, elapsedMs: Date.now() - startTime })
          }
        } else {
          fullText = "Não consegui gerar uma resposta agora (retorno vazio). Tenta de novo, por favor."
          log("error", "Empty response from SDK (not a timeout)")
        }
      }

      // Reação FINAL (portado do tenant-d, 2026-09-21): o modelo pode fechar a
      // resposta com `REACT:<emoji>` numa linha própria; o sistema troca a
      // reação de chegada pela que reflete o que de fato aconteceu no turno e
      // NUNCA deixa o marcador vazar como texto (mesmo com reações desligadas).
      const { texto: textoLimpo, emoji: reacaoFinal } = splitReactMarker(fullText)
      // Resposta que veio SÓ com o marcador (sem texto): manda o emoji como
      // bolha curta em vez de deixar "REACT:..." vazar cru — e sem bolha vazia.
      fullText = textoLimpo.trim() || reacaoFinal || fullText
      if (reacaoFinal && reactionsEnabled()) {
        ctx.api.setMessageReaction(chatId, ctx.message.message_id, [{ type: "emoji", emoji: reacaoFinal }])
          .catch(() => {})
      }

      // Renderiza em HTML (negrito/itálico/código/links) via mdToTelegramHtml
      // — sem isso o Telegram mostra "**assim**" cru em vez de negrito de
      // verdade. Fallback pra texto plano por chunk se o HTML for rejeitado.
      const chunks: string[] = []
      let remaining = fullText
      while (remaining.length > 0) {
        chunks.push(remaining.slice(0, MAX_TELEGRAM_LENGTH))
        remaining = remaining.slice(MAX_TELEGRAM_LENGTH)
      }
      const sendChunk = async (chunk: string, editId?: number) => {
        const html = mdToTelegramHtml(chunk)
        if (editId) {
          await ctx.api.editMessageText(chatId, editId, html, { parse_mode: "HTML" })
            .catch(() => ctx.api.editMessageText(chatId, editId, chunk).catch(() => {}))
        } else {
          await ctx.reply(html, { parse_mode: "HTML" })
            .catch(() => ctx.reply(chunk).catch(() => {}))
        }
      }
      await sendChunk(chunks[0]!, messageId ?? undefined)
      for (const chunk of chunks.slice(1)) {
        await sendChunk(chunk)
      }

      messagesResponded++
      log("info", "Response sent", { durationMs: Date.now() - startTime, responseLength: fullText.length })

      await conversationStore!.addExchange(sanitized, fullText)
      await appendChatLog(principalName, daName, sanitized, fullText)

      lastMessageAt = now

    } catch (err) {
      log("error", "Message processing failed", { error: String(err) })
      await ctx.reply("Tive um problema processando essa mensagem — pode ter sido reinício de serviço ou soluço de infra, não necessariamente algo com o que você escreveu. Espera uns segundos e manda de novo.").catch(() => {})
    }
  }

  /**
   * Preparo de UMA mensagem: mídia vira texto (transcrita, ou uma instrução
   * pra usar Read), depois sanitize + checagem de injeção + comando de clear.
   * Devolve o texto pronto pro turno, ou null se a mensagem já se resolveu
   * aqui (respondeu e encerrou) ou não tem nada processável.
   *
   * Roda DENTRO do dreno, não no handler: download e transcrição levam
   * segundos, e o handler precisa voltar na hora pra fila não represar.
   */
  async function prepareMessage(ctx: any, contexto: string): Promise<string | null> {
    let text = ctx.message.text ?? ctx.message.caption ?? ""

    // Imagem: baixa e injeta o path pro __DA_NAME__ ler com Read (visão pelos olhos do SDK).
    const hasImage = Array.isArray(ctx.message.photo) || String(ctx.message.document?.mime_type ?? "").startsWith("image/")
    if (hasImage) {
      const imgPath = await downloadTelegramImage(ctx, token!)
      if (imgPath) {
        text = `[${principalName} enviou uma imagem, salva em ${imgPath}. Use Read pra vê-la antes de responder.]${text ? `\nLegenda: ${text}` : ""}`
      }
    }

    // Áudio: voice note ou arquivo. Transcreve via Groq (sem language fixo —
    // auto-detecta o idioma). A transcrição vira a mensagem.
    const hasAudio = Boolean(ctx.message.voice || ctx.message.audio) ||
      String(ctx.message.document?.mime_type ?? "").startsWith("audio/")
    if (hasAudio && !hasImage) {
      if (!GROQ_API_KEY) {
        await ctx.reply("Ainda não consigo entender áudio (transcrição não configurada) — manda por texto, por favor.").catch(() => {})
        return null
      }
      await ctx.api.sendChatAction(ctx.chat.id, "typing").catch(() => {})
      const audio = await downloadTelegramAudio(ctx, token!)
      if (!audio) {
        await ctx.reply("Não consegui baixar esse áudio. Tenta de novo?").catch(() => {})
        return null
      }
      let transcript = ""
      try {
        transcript = await transcribeGroq(new Uint8Array(await Bun.file(audio.path).arrayBuffer()), audio.filename)
      } catch (err) {
        log("warn", "transcribeGroq failed", { error: String(err).slice(0, 200) })
        await ctx.reply("Não consegui transcrever esse áudio agora. Tenta de novo ou manda por texto.").catch(() => {})
        return null
      }
      if (!transcript) {
        await ctx.reply("Áudio sem fala reconhecível — não transcrevi nada.").catch(() => {})
        return null
      }
      text = transcript
    }

    // Documento genérico: PDF, CSV, planilha, JSON, zip, .md. Limite de 20MB
    // (teto da própria Bot API do Telegram pra download).
    const hasDocument = Boolean(ctx.message.document) && !hasImage && !hasAudio
    if (hasDocument) {
      const doc = ctx.message.document
      if (typeof doc.file_size === "number" && doc.file_size > MAX_DOCUMENT_BOT_API_BYTES) {
        log("warn", "document too large for Bot API download", { fileName: doc.file_name, fileSize: doc.file_size })
        await ctx.reply(
          `Esse arquivo (${doc.file_name ?? "sem nome"}, ${(doc.file_size / 1024 / 1024).toFixed(1)}MB) passa do limite de 20MB que a API do Telegram libera pra bots baixarem. Manda por outro caminho (Drive, link) que eu leio de lá.`,
        ).catch(() => {})
        return null
      }
      const docResult = await downloadTelegramDocument(ctx, token!)
      if (docResult) {
        if (inboxDir) {
          // Captura determinística (portado do bot vivo, 2026-07-20): anexo
          // recebido vai DIRETO pro inbox configurado — código copia, não o
          // modelo. O SDK só cria a nota-irmã e commita; nada de perguntar
          // "o que fazer com ele" (o processamento vem depois).
          const capturedDay = new Date().toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" })
          const anexoName = `${capturedDay}-${ctx.message.message_id}-${docResult.filename}`.replace(/[^\w.\-]+/g, "-")
          const anexoDir = join(inboxDir, "anexos")
          const anexoPath = join(anexoDir, anexoName)
          let captured = false
          try {
            await mkdir(anexoDir, { recursive: true })
            await Bun.write(anexoPath, Bun.file(docResult.path))
            captured = true
          } catch (err) {
            log("warn", "inbox capture failed, falling back to tmp path", { error: String(err).slice(0, 200) })
          }
          const srcPath = captured ? anexoPath : docResult.path
          text = [
            `[${principalName} enviou um arquivo (${docResult.filename})${captured ? `, já capturado no inbox: ${srcPath}` : `, salvo em ${srcPath} — a cópia automática pro inbox falhou, copie você com Bash pra ${anexoDir}/${anexoName}`}.`,
            `NÃO pergunte o que fazer com ele — destino é o inbox, pra ser processado depois.`,
            `Faça, nesta ordem:`,
            `1) Se o Read abrir (texto, md, PDF, CSV...), leia UMA vez só e resuma em 1-2 linhas do que se trata; se for binário ilegível, registre só tipo/nome/tamanho — sem travar nisso.`,
            `2) Crie ${inboxDir}/${capturedDay}-<slug-curto>.md com frontmatter (source: telegram-file, captured_at, original: ${docResult.filename}, anexo: ${srcPath}) + o resumo + a legenda se houver; se o inbox estiver dentro de um repo git, adicione nota E anexo, commit.`,
            `3) Me responda curto: o que era + onde arquivou. Sem perguntas de acompanhamento.]`,
          ].join("\n") + (text ? `\nLegenda: ${text}` : "")
        } else {
          text = `[${principalName} enviou um arquivo (${docResult.filename}), salvo em ${docResult.path}. Use Read pra abrir antes de responder — se for um binário que o Read não abre, diga que tipo de arquivo é e o que fazer com ele.]${text ? `\nLegenda: ${text}` : ""}`
        }
      } else {
        log("warn", "document received but download failed", { messageId: ctx.message.message_id, fileName: doc.file_name })
        await ctx.reply("Recebi o arquivo mas o download falhou. Tenta reenviar.").catch(() => {})
        return null
      }
    }

    if (!text) return null   // sem texto, imagem, áudio ou documento processável (sticker etc.) — ignora

    const sanitized = sanitize(text)
    if (!sanitized) return null

    const injection = analyzeForInjection(sanitized)
    if (injection.riskLevel === "CRITICAL") {
      log("warn", "Blocked CRITICAL injection attempt", { userId: ctx.from.id, patterns: injection.matchedPatterns })
      await ctx.reply("Mensagem bloqueada por segurança.").catch(() => {})
      return null
    }

    // Sessão nova sob demanda (portado do bot vivo, 2026-07-20): conversas
    // densas engordam o contexto muito antes do corte por idle (60min) ou por
    // teto de tokens, e não havia como "dar um clear" à mão. Interceptado
    // ANTES do SDK. Gatilhos EXATOS (mensagem inteira, case-insensitive,
    // com/sem acento). Clear TOTAL de propósito: sem recap, sem histórico —
    // diferente do corte por idle, que injeta resumo.
    const isClearCmd = /^\s*(\/clear|\/nova|limpa a sess[aã]o|nova sess[aã]o|sess[aã]o nova|limpar sess[aã]o)\s*[.!]?\s*$/i.test(sanitized)
    if (isClearCmd) {
      const prevTokens = lastContextTokens
      lastSessionId = undefined
      lastContextTokens = null
      lastMessageAt = null
      threadStartedAt = Date.now()
      log("info", "session cleared on demand", { chatId: ctx.chat.id, prevTokens })
      await ctx.reply(
        prevTokens
          ? `🧹 Sessão limpa — a anterior estava com ~${Math.round(prevTokens / 1000)}k tokens de contexto. Próxima mensagem começa do zero: sem histórico, sem recap. (Também funciona: "nova sessão".)`
          : `🧹 Sessão limpa. Próxima mensagem começa do zero: sem histórico, sem recap. (Também funciona: "nova sessão".)`,
      ).catch(() => {})
      return null
    }

    return contexto ? `${contexto}\n${sanitized}` : sanitized
  }

  /** Um lote por vez por chat, até a fila esvaziar. */
  async function drainChat(chatId: number): Promise<void> {
    if (processingByChat.get(chatId)) return
    processingByChat.set(chatId, true)
    // "digitando…" renovado a cada 5s: o Telegram expira o indicador sozinho, e
    // turno de trabalho longo ficava em silêncio total até o primeiro token.
    let typingCtx: any = null
    const typing = setInterval(() => { typingCtx?.api.sendChatAction(chatId, "typing").catch(() => {}) }, 5000)
    try {
      let primeiroLote = true
      while ((pendingByChat.get(chatId)?.length ?? 0) > 0) {
        // O que chegou durante o turno anterior pode ser rajada ainda em curso.
        if (!primeiroLote) await new Promise(r => setTimeout(r, BATCH_SETTLE_MS))
        primeiroLote = false
        const lote = pendingByChat.get(chatId)!.splice(0)
        typingCtx = lote[lote.length - 1]!.ctx
        typingCtx.api.sendChatAction(chatId, "typing").catch(() => {})
        await runBatch(lote)
      }
    } finally {
      clearInterval(typing)
      processingByChat.delete(chatId)
    }
  }

  /** Prepara cada mensagem do lote e roda UM turno com o texto de todas. */
  async function runBatch(lote: PendingMsg[]): Promise<void> {
    const ultimo = lote[lote.length - 1]!.ctx
    const partes: string[] = []
    for (const item of lote) {
      try {
        const pronto = await prepareMessage(item.ctx, item.contexto)
        if (pronto) partes.push(pronto)
      } catch (err) {
        log("error", "prepareMessage failed", { error: String(err).slice(0, 300) })
        await item.ctx.reply("Não consegui ler essa mensagem direito — manda de novo?").catch(() => {})
      }
    }
    if (partes.length === 0) return
    if (partes.length > 1) log("info", "lote com várias mensagens num turno só", { chatId: ultimo.chat.id, n: partes.length })

    const userText = partes.length > 1
      ? `(${partes.length} mensagens chegaram em sequência — leia todas antes de responder e trate como uma conversa só.)\n\n${partes.join("\n\n")}`
      : partes[0]!

    await processMessage(ultimo, userText)
  }

  // Handler: só FILTRA e ENFILEIRA — volta na hora, então o loop do grammY
  // nunca espera um turno. O dreno acima roda destacado.
  bot.on("message", (ctx) => {
    messagesReceived++
    const chatId = ctx.chat.id

    const fila = pendingByChat.get(chatId) ?? []
    fila.push({ ctx, contexto: messageContext(ctx.message, ctx.me.id, daName) })
    pendingByChat.set(chatId, fila)

    // Reação de CHEGADA pelo tipo do que veio (⚡ urgente · ✍ áudio · 👀 anexo ·
    // 🤔 pergunta · 🙏 agradecimento) — vale também pra mensagem que chega no
    // meio de um turno e vai pro próximo lote. A final, pelo que aconteceu no
    // turno, quem escolhe é o modelo (marcador REACT, ver processMessage).
    if (reactionsEnabled() && !(ctx.message.text ?? "").startsWith("/")) {
      ctx.react?.(receiptReaction(ctx.message, ctx.message.text ?? ctx.message.caption ?? "") as any)?.catch(() => {})
    }

    if (processingByChat.get(chatId)) return // o dreno em curso pega no próximo lote
    const t = settleTimerByChat.get(chatId)
    if (t) clearTimeout(t)
    settleTimerByChat.set(chatId, setTimeout(() => {
      settleTimerByChat.delete(chatId)
      drainChat(chatId).catch(err => log("error", "dreno da fila crashou", { error: String(err).slice(0, 300) }))
    }, BATCH_SETTLE_MS))
  })

  log("info", "Starting Telegram polling", { allowedUsers: [...allowedUsers], workspaceRoot, identityDir, voiceEnabled: GROQ_API_KEY !== "" })

  await bot.start({
    onStart: (info) => {
      log("info", `Bot started: @${info.username}`, { botId: info.id })
    },
  })
}

/**
 * Stop the Telegram bot gracefully.
 */
export async function stopTelegram(): Promise<void> {
  if (!bot) return
  log("info", "Stopping Telegram bot")
  bot.stop()
  bot = null
  activeConfig = null
  log("info", "Telegram bot stopped")
}

/**
 * Return health status for the container's health check.
 */
export function telegramHealth(): {
  status: "running" | "stopped" | "disabled"
  uptime_ms: number
  messages_received: number
  messages_responded: number
  processing: boolean
  queued: number
  last_session_id?: string
} {
  if (!bot) {
    return {
      status: activeConfig?.enabled === false ? "disabled" : "stopped",
      uptime_ms: 0,
      messages_received: 0,
      messages_responded: 0,
      processing: false,
      queued: 0,
    }
  }

  return {
    status: "running",
    uptime_ms: Date.now() - startedAt,
    messages_received: messagesReceived,
    messages_responded: messagesResponded,
    processing: [...processingByChat.values()].some(Boolean),
    queued: [...pendingByChat.values()].reduce((n, fila) => n + fila.length, 0),
    last_session_id: lastSessionId,
  }
}
