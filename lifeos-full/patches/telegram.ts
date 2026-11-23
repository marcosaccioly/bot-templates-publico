/**
 * LifeOS Pulse — Telegram Module
 *
 * grammY polling bot absorbed into Pulse as a long-running module.
 * Does NOT create its own HTTP server — health is reported via the
 * parent's /health endpoint using telegramHealth().
 *
 * Architecture: grammY polling → auth → SDK session → stream → Telegram
 */

import { Bot, InputFile } from "grammy"
import { query } from "@anthropic-ai/claude-agent-sdk"
import { ConversationStore } from "../lib/conversation"
import { sanitize, analyzeForInjection } from "../lib/sanitize"
import { disambiguateHomographs } from "../lib/homographs"
import { join } from "path"
import { appendFile, mkdir, readFile, rm } from "fs/promises"
import { existsSync, readFileSync, writeFileSync } from "fs"
import { inference } from "../../TOOLS/Inference"
import { loadPaiConfig } from "../../TOOLS/PaiConfig"
import { read as readMemory, type ReadResult as MemoryReadResult } from "../../TOOLS/MemoryWriter"
import { getRelevantContext } from "../../TOOLS/MemoryRetriever"
import {
  loadProposalQueue,
  markProposal,
  parseProposalReply,
  formatProposalMessage,
  applyProposalEdit,
  logProposalEvent,
  logProposalReply,
  type ProposalRow,
  type ProposalReply,
} from "../lib/telegram-proposals"
import { stripModeScaffolding, hasModeScaffolding } from "../lib/strip-mode-scaffolding"
import { mdToTelegramHtml } from "../lib/telegram-format"

// BILLING: Strip ANTHROPIC_API_KEY and ANTHROPIC_AUTH_TOKEN before any SDK
// query() call. Bun auto-loads ~/.claude/.env into this process; if either key
// is present, @anthropic-ai/claude-agent-sdk bills it directly instead of the
// CLAUDE_CODE_OAUTH_TOKEN subscription (both outrank OAuth in Anthropic's auth
// precedence chain). This was the root cause of an early-2026 Sonnet 4.5
// $XXX + Web Search $YY invoice — every Telegram message was a 25-turn
// SDK session billed to the API. Mirrors LIFEOS/TOOLS/Inference.ts:116-117.
delete process.env.ANTHROPIC_API_KEY
delete process.env.ANTHROPIC_AUTH_TOKEN

// Capture the ElevenLabs API key into a module-local constant at import
// time. We do NOT delete from process.env here because the Pulse VoiceServer
// module reads ELEVENLABS_API_KEY at its own init time and needs the key to
// stay present for the CLI /notify channel. The advisor-recommended scrub
// pattern (deleting from env) breaks Voice when Telegram imports first.
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY ?? ""

// Groq Whisper — transcription of inbound voice notes / audio files. Same
// engine/model the prior capture bot used (whisper-large-v3-turbo, pt). OGG/Opus
// is Telegram's native voice format and Groq accepts it directly.
const GROQ_API_KEY = process.env.GROQ_API_KEY ?? ""
const GROQ_TRANSCRIPTION_URL = "https://api.groq.com/openai/v1/audio/transcriptions"
const GROQ_WHISPER_MODEL = "whisper-large-v3-turbo"
const GROQ_FETCH_TIMEOUT_MS = 120_000            // long audio takes longer; 2min ceiling
const LONG_AUDIO_THRESHOLD_SEC = 300             // >5min → archive-mode (understand + file), not a spoken command

// ── Config Interface ──

export interface TelegramConfig {
  enabled: boolean
  bot_token?: string
  allowed_users?: number[]
  max_turns?: number
  /** LEGADO — ignorado. Substituído pelo watchdog de inatividade + hard cap abaixo. */
  sdk_timeout_ms?: number
  /** Aborta o turno após este silêncio REAL do SDK (rearmado a cada evento). */
  sdk_inactivity_ms?: number
  /** Rede de segurança absoluta pro turno inteiro, trabalhando ou não. */
  sdk_hard_cap_ms?: number
  edit_interval_ms?: number
  // Modelo do SDK. Sem isto o query() cai no default do harness (hoje Sonnet 4.5).
  // Roda na assinatura (CLAUDE_CODE_OAUTH_TOKEN) — trocar de modelo é dentro do plano.
  model?: string
  fallback_model?: string
  // Único controle de esforço/raciocínio exposto pelo Options do agent-sdk v0.1.77
  // (não há campo `effort`/`thinking` nesta versão). O harness traduz o teto de
  // tokens de thinking pro effort do modelo. Mais alto = mais esforço, mais latência.
  max_thinking_tokens?: number
}

// ── Constants ──

const HOME = process.env.HOME ?? ""
const CWD = join(HOME, ".claude")
const STATE_DIR = join(HOME, ".claude", "LifeOS", "PULSE", "state", "telegram")
const LOGS_DIR = join(HOME, ".claude", "LifeOS", "PULSE", "logs", "telegram")
const STALE_ACK_CACHE_DIR = join(STATE_DIR, "ack-cache")
// Toggle de áudio (#7 da cauda vps-deploy). Persiste se o resumo falado por-turno
// está ligado. Ausência do arquivo = ligado (default histórico). Só afeta o
// sendVoiceSummary automático — a voz sob demanda (/api/telegram/send-voice) ignora.
const VOICE_MODE_FILE = join(STATE_DIR, "voice-mode.json")
const MAX_TELEGRAM_LENGTH = 4096
// Budget usado pra fatiar mensagens longas — abaixo do teto bruto de 4096 pra
// sobrar espaço pras tags HTML que o mdToTelegramHtml acrescenta (negrito/
// código/links crescem a contagem de char depois do split ser decidido).
const TELEGRAM_CHUNK_BUDGET = 3500
const CURSOR = " ▌"
const SHORT_REPLY_WORDS = 8                     // text replies shorter than this skip voice synthesis
const MAX_VOICE_SUMMARY_WORDS = 60              // hard cap if Sonnet ignores the soft 30-word limit
const CONTEXT_BLOCK_MAX_CHARS = 60_000          // ceiling on the per-turn LifeOS memory injection — fits DA + PRINCIPAL identity + TELOS + active sessions + the two _MEMORY.md hot-layer files (ISA ISC-29; worst case ~50k under ISC-30)
const IDLE_TIMEOUT_MS = 60 * 60 * 1000          // 1 hour — gap of silence that resets the SDK session + drops prior history injection
const INFERENCE_HARD_BUDGET_MS = 10_000         // outer race cap on summarize; measured Sonnet subprocess cost is 4-6s, this gives slack without losing the voice trailing the text by too much
const MIN_FALLBACK_WORDS = 6                    // a fallback summary shorter than this is presumed too thin to be worth voicing
const MEANINGFUL_REPLY_WORDS = 25               // when a reply is at least this long, a too-short fallback is a regression — skip voice rather than ship a "0:00" stub
const LIFEOS_DIR = join(HOME, ".claude", "LIFEOS")
// Vault do tenant — onde o SDK arquiva transcrições de áudio
// longo. Fica em ~/vault (LIFEOS_VAULT_DIR). Override
// por env pra portabilidade.
const VAULT_DIR = process.env.LIFEOS_VAULT_DIR ?? join(HOME, "vault")

// Voice ID for outbound voice summaries. Read at module import from
// PaiConfig — `[da.voices.main] voice_id` in LIFEOS/USER/CONFIG/LIFEOS_CONFIG.toml.
// PaiConfig is the typed interface between system code (this file) and user
// data (the voice ID); the migration from direct settings.json reads to
// PaiConfig is the Phase F win — one source of truth, no parallel paths.
//
// Fallback: ElevenLabs' public "Rachel" voice (21m00Tcm4TlvDq8ikWAM) — used
// only when PaiConfig is unavailable or missing required fields. Matches the
// public release's bootstrap DA_IDENTITY template default so a fresh install
// that hasn't run Interview yet still gets a functional (if generic) voice.
// The fallback must remain a public voice — release-time scrubbing trusts
// this literal as safe-to-ship.
//
// We intentionally do NOT read `process.env.ELEVENLABS_VOICE_ID` here — that
// env var historically held a different voice in some installs, and using it
// caused Telegram and CLI voices to diverge.
const DA_VOICE_ID = ((): string => {
  try {
    const v = loadPaiConfig().da.voices.main.voiceId
    if (v && typeof v === "string" && v.length > 0) return v
  } catch { /* fall through to public default */ }
  return "21m00Tcm4TlvDq8ikWAM"  // ElevenLabs "Rachel" — public voice
})()

// ── Module State ──

let bot: Bot | null = null
let conversationStore: ConversationStore | null = null
let processing = false
let startedAt = 0
let messagesReceived = 0
let messagesResponded = 0
let lastSessionId: string | undefined
let activeConfig: TelegramConfig | null = null
let lastVoiceSendMs: number | null = null

// Idle-session-boundary state.
//   lastMessageAt   = timestamp of the LAST fully-successful exchange. Used to
//                     detect when a fresh message lands after IDLE_TIMEOUT_MS.
//   threadStartedAt = timestamp of the start of the current thread. The history
//                     injection filters to messages with timestamp >= this, so
//                     a fresh thread sees no prior conversation injected into
//                     the prompt even though conversations.json still holds it.
//
// Single-chat assumption: these are module-global, matching the existing
// `lastSessionId` shape. If the allowlist ever grows past one chat, boundary
// state must be keyed per-chat (Map<chatId, { lastMessageAt, threadStartedAt }>).
let lastMessageAt: number | null = null
let threadStartedAt: number = 0
// Último chat que falou comigo — alvo default do endpoint /api/telegram/send-voice
// quando o chamador não passa chatId explícito.
let lastChatId: number | null = null

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

async function appendChatLog(userMsg: string, botMsg: string) {
  const chatLogPath = join(LOGS_DIR, "chat-log.md")
  const ts = new Date().toLocaleString("en-US", {
    timeZone: "America/Sao_Paulo",
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  })
  const entry = `\n### ${ts}\n**{{PRINCIPAL_NAME}}:** ${userMsg}\n\n**{{DA_NAME}}:** ${botMsg}\n\n---\n`
  await appendFile(chatLogPath, entry).catch(() => {})
}

// ── LifeOS Context Injection ──

const CONTEXT_SOURCES: ReadonlyArray<{ rel: string; label: string }> = [
  { rel: "USER/DIGITAL_ASSISTANT/DA_IDENTITY.md", label: "DA_IDENTITY" },
  { rel: "USER/PRINCIPAL/PRINCIPAL_IDENTITY.md", label: "PRINCIPAL_IDENTITY" },
  { rel: "USER/TELOS/PRINCIPAL_TELOS.md", label: "PRINCIPAL_TELOS" },
  { rel: "USER/PROJECTS.md", label: "PROJECTS" },
]

// Hot-layer memory files — read via MemoryWriter.read() so frontmatter, comments,
// and malformed entries are stripped before injection. Mtimes participate in the
// 60s cache invalidation alongside CONTEXT_SOURCES so a fresh Reviewer write is
// visible on the next turn within the cache window (ISA ISC-31).
const MEMORY_SOURCES: ReadonlyArray<{ rel: string; title: string }> = [
  { rel: "USER/PRINCIPAL/PRINCIPAL_MEMORY.md", title: "PRINCIPAL MEMORY" },
  { rel: "USER/DIGITAL_ASSISTANT/DA_MEMORY.md", title: "DA MEMORY" },
]

const CONTEXT_CACHE_TTL_MS = 60_000
let cachedContext: { text: string; builtAt: number; mtimes: Record<string, number> } | null = null

/**
 * Format a hot-layer memory file for injection into the LifeOS CONTEXT block.
 * Header pattern per ISA ISC-25/26/27. Empty file renders the empty-but-ready
 * signal so the model sees the file exists and is wired up.
 */
function formatMemoryBlock(title: string, r: MemoryReadResult): string {
  const header = `## ${title} [${r.count}/${r.cap_entries} entries · ${r.chars_used}/${r.cap_chars} chars]`
  if (r.count === 0) return `${header}\n(no entries yet)`
  return `${header}\n${r.entries.join("\n")}`
}

/**
 * Read the four files that anchor situational awareness — who {{PRINCIPAL_NAME}} is, who
 * {{DA_NAME}} is, what {{PRINCIPAL_NAME}}'s goals are, what's in flight today — and assemble a
 * single markdown blob for the SDK system prompt.
 *
 * Cached with a 60s TTL plus per-file mtime invalidation, so a busy session
 * doesn't pay 4 fs reads + assembly per turn but a freshly-edited TELOS or
 * PROJECTS entry takes effect on the very next message. Each file is read with
 * its own try/catch so a missing source degrades to a placeholder rather than
 * blowing up the whole turn.
 */
export async function buildPaiContextBlock(query?: string): Promise<string> {
  const { stat } = await import("fs/promises")

  // Cheap mtime probe to decide if the cache is still valid. Both the four
  // identity/TELOS/projects sources AND the two hot-layer memory files
  // participate so a Reviewer-driven memory write invalidates the cache on the
  // next turn within the 60s window.
  const mtimes: Record<string, number> = {}
  const probeRels = [
    ...CONTEXT_SOURCES.map((s) => s.rel),
    ...MEMORY_SOURCES.map((s) => s.rel),
  ]
  await Promise.all(probeRels.map(async (rel) => {
    try {
      const st = await stat(join(LIFEOS_DIR, rel))
      mtimes[rel] = st.mtimeMs
    } catch {
      mtimes[rel] = 0
    }
  }))

  // When a query is provided, the relevant-memory injection makes the block
  // query-dependent — skip the static cache. The MemoryRetriever has its own
  // per-query cache that absorbs repeated calls within a turn cluster.
  if (cachedContext && !query) {
    const age = Date.now() - cachedContext.builtAt
    const mtimesUnchanged = Object.entries(mtimes)
      .every(([k, v]) => cachedContext!.mtimes[k] === v)
    if (age < CONTEXT_CACHE_TTL_MS && mtimesUnchanged) {
      return cachedContext.text
    }
  }

  const readSafe = async (rel: string, label: string): Promise<string> => {
    try {
      const raw = await readFile(join(LIFEOS_DIR, rel), "utf8")
      return raw.trim()
    } catch (err) {
      log("warn", "context-block: file unavailable", { rel, error: String(err).slice(0, 120) })
      return `(${label} unavailable on disk)`
    }
  }

  // PROJECTS.md is mostly a stable routing table; the volatile part is the
  // "Open Sessions to Resume" section. Inject only that slice — the rest of
  // the file is reachable via the SDK's Read tool on demand.
  const extractActiveSessions = (projectsBody: string): string => {
    const m = projectsBody.match(/##\s+Open Sessions to Resume[\s\S]*$/)
    return m ? m[0].trim() : "(no Open Sessions section found)"
  }

  const [daIdentity, principalIdentity, principalTelos, projectsBody] = await Promise.all(
    CONTEXT_SOURCES.map(({ rel, label }) => readSafe(rel, label)),
  )
  const activeSessions = extractActiveSessions(projectsBody)

  // Hot-layer memory reads. readMemory degrades gracefully on missing files
  // (returns zero-entry result, ISC-32) and silently drops malformed entries
  // at read time (ISC-19). Both files are validated by MemoryWriter at write
  // time too, so this is belt-and-suspenders, not the primary gate.
  const memoryBlocks = MEMORY_SOURCES.map(({ rel, title }) => {
    try {
      const r = readMemory(join(LIFEOS_DIR, rel))
      if ("code" in r) {
        log("warn", "context-block: memory read returned error", { rel, code: r.code })
        return `## ${title} [0/48 entries · 0/12288 chars]\n(no entries yet)`
      }
      return formatMemoryBlock(title, r)
    } catch (err) {
      log("warn", "context-block: memory read threw", { rel, error: String(err).slice(0, 120) })
      return `## ${title} [0/48 entries · 0/12288 chars]\n(no entries yet)`
    }
  })

  const today = new Date().toLocaleString("en-US", {
    timeZone: "America/Sao_Paulo",
    weekday: "long", year: "numeric", month: "long", day: "numeric",
    hour: "numeric", minute: "2-digit",
  })

  // Per-turn relevant-memory retrieval (F6). Only runs when a query is given —
  // typically the latest user message in the active Telegram exchange. Pure
  // BM25 over the typed-item corpus (KNOWLEDGE + the two _MEMORY.md files);
  // synchronous and cheap. Returns empty string when nothing scores above
  // threshold — keeps the prompt free of irrelevant noise.
  let relevantMemoryBlock = ""
  if (query && query.trim().length > 0) {
    try {
      const ctx = getRelevantContext(query)
      relevantMemoryBlock = ctx.markdownBlock
    } catch (err) {
      log("warn", "context-block: relevant-memory retrieval failed", { error: String(err).slice(0, 120) })
    }
  }

  // Ordering rule (ISA ISC-24 + ISC-76): memory hot-layer blocks land AFTER
  // PRINCIPAL_IDENTITY, BEFORE PRINCIPAL_TELOS. The per-turn RELEVANT MEMORY
  // block lands immediately after the hot-layer, so the model sees:
  //   identity → durable memory → relevant retrieved memory → goals.
  let block = [
    "## LifeOS CONTEXT (refreshed every turn, do not narrate this header)",
    "",
    `**Today:** ${today} (America/Sao_Paulo)`,
    "",
    "### About you ({{DA_NAME}})",
    daIdentity,
    "",
    "### About {{PRINCIPAL_NAME}}",
    principalIdentity,
    "",
    memoryBlocks[0],
    "",
    memoryBlocks[1],
    ...(relevantMemoryBlock ? ["", relevantMemoryBlock] : []),
    "",
    "### {{PRINCIPAL_NAME}}'s TELOS",
    principalTelos,
    "",
    "### Active sessions / in-flight work",
    activeSessions,
  ].join("\n")

  // Trailing marker tells the model this is a hard cut — it can Read the
  // source files directly if it needs more.
  if (block.length > CONTEXT_BLOCK_MAX_CHARS) {
    block = block.slice(0, CONTEXT_BLOCK_MAX_CHARS - 200) +
      "\n\n…[context truncated to fit per-turn budget — Read the source files directly if you need more]"
  }

  // Only cache the query-free baseline. Query-driven blocks are per-turn.
  if (!query) {
    cachedContext = { text: block, builtAt: Date.now(), mtimes }
  }
  return block
}

// ── Identity Proposal Surfacing (F7) ──
//
// Pure helpers (load/parse/format/apply queue I/O) live in
// LIFEOS/PULSE/lib/telegram-proposals.ts for unit testability. This module
// keeps only the bot.api.sendMessage glue and the per-turn drain dispatcher.
//
// Spec: ISA MEMORY/WORK/20260522-223538_pai-hermes-parity-memory/ISA.md ISC-82..95.
// ISC-85/86 (confidence-gated silent direct-apply) are superseded by the 2026-05-23
// Decisions row that routes ALL proposals through Telegram approval until the F5
// reviewer-driven direct-apply orchestrator ships.

async function surfaceProposalToChat(chatId: number, row: ProposalRow): Promise<boolean> {
  if (!bot) return false
  try {
    await bot.api.sendMessage(chatId, formatProposalMessage(row))
    markProposal(row.id, { status: "sent", surfaced_at: new Date().toISOString() })
    logProposalEvent({ id: row.id, file: row.target_file, edit: row.edit, confidence: row.confidence, status: "sent" })
    return true
  } catch (e) {
    log("warn", "surfaceProposalToChat: send failed", { id: row.id, error: String(e) })
    return false
  }
}

async function drainPendingProposals(chatId: number, maxPerCall: number = 1): Promise<number> {
  // Surface up to N pending proposals to the principal's chat. Rate-limited
  // per turn to avoid spam. Returns the number successfully surfaced.
  const queue = loadProposalQueue()
  const pending = queue.filter((r) => r.status === "pending")
  let sent = 0
  for (const row of pending.slice(0, maxPerCall)) {
    const ok = await surfaceProposalToChat(chatId, row)
    if (ok) sent += 1
  }
  return sent
}

async function handleProposalReply(chatId: number, reply: ProposalReply, ctx: { reply: (text: string) => Promise<unknown> }): Promise<"handled" | "passthrough"> {
  if (reply.kind === null) return "passthrough"

  if (reply.kind === "list") {
    const queue = loadProposalQueue()
    const showable = queue.filter((r) => r.status === "pending" || r.status === "sent")
    if (showable.length === 0) {
      await ctx.reply("📋 No pending proposals.").catch(() => {})
      return "handled"
    }
    for (const row of showable) {
      await ctx.reply(formatProposalMessage(row)).catch(() => {})
      if (row.status === "pending") {
        markProposal(row.id, { status: "sent", surfaced_at: new Date().toISOString() })
      }
    }
    logProposalReply({ kind: "list", count: showable.length, chatId })
    return "handled"
  }

  const row = loadProposalQueue().find((r) => r.id === reply.id)
  if (!row) {
    await ctx.reply(`🤷 No proposal with id #${reply.id}. Try \`proposals\` to list pending ones.`).catch(() => {})
    logProposalReply({ kind: reply.kind, id: reply.id, outcome: "id-not-found", chatId })
    return "handled"
  }

  if (reply.kind === "yes") {
    const result = applyProposalEdit(row.target_file, row.edit)
    if (result.ok) {
      markProposal(row.id, { status: "accepted", resolved_at: new Date().toISOString(), applied_edit: row.edit })
      logProposalEvent({ id: row.id, file: row.target_file, edit: row.edit, confidence: row.confidence, status: "accepted" })
      logProposalReply({ kind: "yes", id: row.id, outcome: "applied", chatId })
      const fileLabel = row.target_file.replace(`${HOME}/.claude/`, "")
      await ctx.reply(`✅ Applied to ${fileLabel}`).catch(() => {})
    } else {
      logProposalReply({ kind: "yes", id: row.id, outcome: "apply-failed", reason: result.reason, chatId })
      await ctx.reply(`❌ Couldn't apply: ${result.reason}`).catch(() => {})
    }
    return "handled"
  }

  if (reply.kind === "no") {
    markProposal(row.id, { status: "rejected", resolved_at: new Date().toISOString() })
    logProposalEvent({ id: row.id, file: row.target_file, edit: row.edit, confidence: row.confidence, status: "rejected" })
    logProposalReply({ kind: "no", id: row.id, outcome: "rejected", chatId })
    await ctx.reply("🚫 Discarded.").catch(() => {})
    return "handled"
  }

  // reply.kind === "edit"
  if (!reply.editText || reply.editText.length === 0) {
    await ctx.reply(`✏️ Provide the edited text: \`edit #${reply.id} <your text>\``).catch(() => {})
    return "handled"
  }
  const result = applyProposalEdit(row.target_file, reply.editText)
  if (result.ok) {
    markProposal(row.id, { status: "edited", resolved_at: new Date().toISOString(), applied_edit: reply.editText })
    logProposalEvent({ id: row.id, file: row.target_file, edit: reply.editText, confidence: row.confidence, status: "edited" })
    logProposalReply({ kind: "edit", id: row.id, outcome: "applied", chatId })
    const fileLabel = row.target_file.replace(`${HOME}/.claude/`, "")
    await ctx.reply(`✅ Applied your edit to ${fileLabel}`).catch(() => {})
  } else {
    logProposalReply({ kind: "edit", id: row.id, outcome: "apply-failed", reason: result.reason, chatId })
    await ctx.reply(`❌ Couldn't apply: ${result.reason}`).catch(() => {})
  }
  return "handled"
}

// ── Voice Summary Pipeline ──

/**
 * Sonnet inference call that summarizes a bot text reply into ≤2 sentences in
 * {{DA_NAME}}'s voice. Output is what ElevenLabs will synthesize for the Telegram voice
 * note. Failures fall back to the first sentence of the reply.
 */
export interface VoiceSummaryResult {
  summary: string
  /** "inference" = Sonnet produced this; "fallback" = the timeout / failure path returned first-sentence text */
  source: "inference" | "fallback"
}

export async function summarizeForVoice(replyText: string): Promise<VoiceSummaryResult> {
  const systemPrompt = [
    "You are {{DA_NAME}}, {{PRINCIPAL_NAME}}'s AI assistant.",
    "Task: write a SHORT voice summary of a text reply that was just sent.",
    // Language is pinned. The reply is in Brazilian Portuguese and the summary
    // is fed straight to a pt-BR TTS voice — output MUST be pt-BR regardless of
    // any English in the source. Without this, the model mirrors the English
    // example lines below and the voice note ships in the wrong language.
    "ALWAYS write the summary in Brazilian Portuguese (pt-BR). Never English, no matter what language appears in the text.",
    "Output ONE OR TWO declarative sentences, ≤30 words total.",
    "Lead with the answer. No preamble, no 'então basicamente', no 'quero comentar que'.",
    "Plain prose. No markdown. No emoji. No labels. No quotes around your output.",
    "Speak as {{DA_NAME}} — precise, fast, low-ego, opinionated, attention-as-warmth.",
    "Voice samples in {{DA_NAME}}'s style (pt-BR — match this language and rhythm):",
    "  'Feito. Hooks dispararam, ISA em 14/14, pode subir.'",
    "  'Vai de B. O A é mais rápido, mas você reescreve em um mês.'",
    "  'Três não lidas, duas do Bryan sobre a UL. Nada urgente.'",
    "  'Bot ouvindo. Manda de novo — responde na hora agora.'",
    "Match that rhythm, in pt-BR. Output the summary text only — no other content.",
  ].join("\n")

  // Outer race on inference subprocess. Sonnet via Inference.ts spawns the
  // claude CLI (~1-2s) + does inference (~2-4s for short outputs), so the
  // realistic floor is ~4-6s. INFERENCE_HARD_BUDGET_MS gives slack without
  // letting a hung subprocess delay the voice past usefulness.
  try {
    const result = await Promise.race([
      inference({
        systemPrompt,
        userPrompt: replyText,
        level: "medium",  // Sonnet
        timeout: 20_000,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`inference exceeded ${INFERENCE_HARD_BUDGET_MS}ms outer budget`)), INFERENCE_HARD_BUDGET_MS),
      ),
    ])
    if (!result.success || !result.output) {
      log("warn", "summarizeForVoice: inference failed, falling back", { error: result.error })
      return { summary: fallbackFirstSentence(replyText), source: "fallback" }
    }
    return { summary: tidySummary(result.output), source: "inference" }
  } catch (err) {
    log("warn", "summarizeForVoice: threw or timed out, falling back", { error: String(err).slice(0, 200) })
    return { summary: fallbackFirstSentence(replyText), source: "fallback" }
  }
}

function tidySummary(raw: string): string {
  let s = raw.trim()
  // Strip wrapping quotes
  s = s.replace(/^["'`]+|["'`]+$/g, "")
  // Strip leading speaker labels ({{DA_NAME}}:, Summary:, etc.)
  s = s.replace(/^(kai|summary|voice|output|response)[:\-—]\s*/i, "")
  // Strip leading list markers
  s = s.replace(/^[-*•]\s+/, "")
  // Collapse internal whitespace
  s = s.replace(/\s+/g, " ").trim()
  // Length cap
  const words = s.split(/\s+/)
  if (words.length > MAX_VOICE_SUMMARY_WORDS) {
    log("warn", "summarizeForVoice: output exceeded word cap, truncating", {
      wordCount: words.length, cap: MAX_VOICE_SUMMARY_WORDS,
    })
    s = words.slice(0, MAX_VOICE_SUMMARY_WORDS).join(" ").replace(/[,;:\s]+$/, "") + "…"
  }
  return s
}

function fallbackFirstSentence(text: string): string {
  const m = text.match(/^[\s\S]*?[.!?](?=\s|$)/)
  // No sentence terminator (e.g., markdown bullet list reply) — fall back to
  // the first 30 words instead of returning the whole long reply.
  const raw = m ? m[0] : text.split(/\s+/).slice(0, 30).join(" ")
  return tidySummary(raw.trim())
}

/**
 * Synthesize a {{DA_NAME}}-voice OGG/Opus blob via ElevenLabs. Returns the raw audio
 * bytes as a Buffer; never writes to disk. Telegram's sendVoice consumes the
 * Buffer via grammY's InputFile constructor.
 */
export async function synthesizeKaiVoice(text: string): Promise<Buffer> {
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${DA_VOICE_ID}?output_format=opus_48000_64`
  const spokenText = disambiguateHomographs(text)
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "xi-api-key": ELEVENLABS_API_KEY,
      "Accept": "audio/ogg",
    },
    body: JSON.stringify({
      text: spokenText,
      model_id: "eleven_turbo_v2_5",
      // Pin the language. Without language_code, eleven_turbo_v2_5 auto-detects
      // per-request from the text and mis-guesses on short/ambiguous summaries —
      // the audio then ships in English instead of pt-BR. Same fix already
      // applied to VoiceServer/voice.ts; this is the separate Telegram path.
      language_code: "pt",
      voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0, speed: 1.0, use_speaker_boost: true },
    }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => "<unreadable>")
    throw new Error(`ElevenLabs ${res.status}: ${body.slice(0, 200)}`)
  }
  const ab = await res.arrayBuffer()
  return Buffer.from(ab)
}

// Teto de segurança pro ElevenLabs turbo — texto além disso é truncado antes de
// sintetizar (evita erro de payload em respostas completas muito longas).
const SEND_VOICE_MAX_CHARS = 5000

/**
 * Lê a duração em segundos de um blob OGG/Opus a partir do granulepos da
 * última página "OggS" — a especificação Ogg Opus fixa essa unidade em
 * 48kHz, independente do sample rate real do stream. O Telegram Web usa o
 * campo `duration` da Bot API pra desenhar o player; sem ele, mostra sempre
 * "0:00" mesmo com áudio válido e tocável (o granulepos em si está correto,
 * só não é lido pelo cliente). Retorna undefined se não achar página OGG.
 */
function oggOpusDurationSec(buf: Buffer): number | undefined {
  for (let i = buf.length - 27; i >= 0; i--) {
    if (buf[i] === 0x4f && buf[i + 1] === 0x67 && buf[i + 2] === 0x67 && buf[i + 3] === 0x53) {
      const granule = buf.readBigUInt64LE(i + 6)
      return granule > 0n ? Number(granule) / 48000 : undefined
    }
  }
  return undefined
}

/**
 * Fatia `text` em pedaços ≤ `budget` chars pra caber no limite do Telegram,
 * preferindo fronteira de parágrafo (linha em branco), caindo pra fronteira
 * de linha, e só cortando no meio de uma linha como último recurso (linha
 * isolada maior que o budget). Nunca corta no meio de parágrafo/linha quando
 * existe uma fronteira melhor disponível — evita partir tag HTML ou palavra
 * no meio, que era o defeito do slice(0, MAX_TELEGRAM_LENGTH) cego anterior.
 */
function splitForTelegram(text: string, budget: number = TELEGRAM_CHUNK_BUDGET): string[] {
  if (text.length <= budget) return [text]

  const chunks: string[] = []
  let current = ""
  const flush = () => {
    if (current) {
      chunks.push(current)
      current = ""
    }
  }
  const hardCut = (piece: string) => {
    let rest = piece
    while (rest.length > budget) {
      chunks.push(rest.slice(0, budget))
      rest = rest.slice(budget)
    }
    current = rest
  }

  for (const para of text.split(/\n{2,}/)) {
    const withPara = current ? `${current}\n\n${para}` : para
    if (withPara.length <= budget) {
      current = withPara
      continue
    }
    flush()
    if (para.length <= budget) {
      current = para
      continue
    }
    for (const line of para.split("\n")) {
      const withLine = current ? `${current}\n${line}` : line
      if (withLine.length <= budget) {
        current = withLine
        continue
      }
      flush()
      if (line.length <= budget) current = line
      else hardCut(line)
    }
  }
  flush()
  return chunks
}

/**
 * HTTP handler do módulo Telegram (roteado pelo pulse.ts). Serve um endpoint:
 *   POST /api/telegram/send-voice  { text, chatId? }
 * Sintetiza `text` na voz do {{DA_NAME}} e posta como voice note no chat. É o
 * canal pelo qual o Jão manda áudio custom SOB DEMANDA — a resposta completa
 * falada (quando o operador pede "me responde em áudio") ou um recado pra
 * encaminhar — distinto do resumo curto automático de cada turno. chatId
 * omitido → usa o último chat ativo. Devolve null pra paths não-Telegram, então
 * o pulse.ts segue tentando os outros módulos.
 */
export async function handleTelegramRequest(req: Request, pathname: string): Promise<Response | null> {
  if (pathname !== "/api/telegram/send-voice") return null
  const json = (obj: unknown, status: number) =>
    new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } })
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405)
  try {
    const body = (await req.json().catch(() => ({}))) as { text?: unknown; chatId?: unknown }
    const text = typeof body.text === "string" ? body.text.trim() : ""
    if (!text) return json({ error: "Missing or invalid 'text'" }, 400)
    const targetChatId = typeof body.chatId === "number" ? body.chatId : lastChatId
    if (!targetChatId) return json({ error: "No active chat and no chatId provided" }, 400)
    if (!bot) return json({ error: "Telegram bot not running" }, 503)
    const spoken = text.length > SEND_VOICE_MAX_CHARS ? text.slice(0, SEND_VOICE_MAX_CHARS) : text
    const buf = await synthesizeKaiVoice(spoken)
    const sent = await bot.api.sendVoice(targetChatId, new InputFile(buf, "kai-voice.ogg"), {
      duration: oggOpusDurationSec(buf),
    })
    log("info", "send-voice: áudio custom postado", {
      chatId: targetChatId, chars: spoken.length, truncated: spoken.length < text.length,
    })
    return json({ success: true, voiceMessageId: sent.message_id }, 200)
  } catch (err) {
    log("error", "send-voice failed", { error: String(err).slice(0, 300) })
    return json({ error: String(err).slice(0, 300) }, 500)
  }
}

/**
 * Fire-and-forget orchestrator: takes the bot's final text reply, summarizes
 * via Sonnet, synthesizes via ElevenLabs, ships as a Telegram voice note.
 *
 * - Short replies (<8 words) skip the entire round trip — the text is already
 *   the summary.
 * - Missing ELEVENLABS_API_KEY at boot disables the feature with one log line.
 * - Every failure path (summarize, synth, sendVoice) is swallowed at WARN.
 *   The primary text reply has already shipped by the time this runs.
 * - Never await this function from the message handler — it MUST be a void
 *   IIFE so a TTS hang cannot block the SDK loop or the `processing = false`
 *   release in `finally`.
 */
/** Lê o toggle de voz. Default: ligado (arquivo ausente/ilegível → true). */
function isVoiceEnabled(): boolean {
  try {
    if (!existsSync(VOICE_MODE_FILE)) return true
    return JSON.parse(readFileSync(VOICE_MODE_FILE, "utf8"))?.enabled !== false
  } catch {
    return true
  }
}

/** Persiste o toggle de voz. Idempotente; cria o STATE_DIR se preciso. */
function setVoiceEnabled(enabled: boolean): void {
  try {
    writeFileSync(VOICE_MODE_FILE, JSON.stringify({ enabled }), "utf8")
  } catch (err) {
    log("warn", "failed to persist voice-mode flag", { error: String(err).slice(0, 200) })
  }
}

/**
 * Detecta o comando de toggle de voz numa mensagem. Ancorado e curto pra não
 * casar no meio de conversa normal. Retorna "on"/"off" ou null (não é comando).
 */
function parseVoiceModeCommand(text: string): "on" | "off" | null {
  const t = text.trim().toLowerCase().replace(/[.!?]+$/, "")
  if (t.length > 40) return null   // comando é frase curta, não parágrafo
  const OFF = ["modo silencioso", "modo mudo", "silencio", "silêncio", "sem voz", "sem audio", "sem áudio", "desliga a voz", "desliga o audio", "desliga o áudio", "para de falar", "muta", "mudo"]
  const ON = ["modo voz", "modo audio", "modo áudio", "liga a voz", "religa a voz", "liga o audio", "liga o áudio", "religa o audio", "religa o áudio", "com voz", "volta a falar", "pode falar"]
  if (OFF.some(p => t === p || t === `${p} jão` || t === `jão ${p}`)) return "off"
  if (ON.some(p => t === p || t === `${p} jão` || t === `jão ${p}`)) return "on"
  return null
}

export function sendVoiceSummary(
  ctx: {
    chat: { id: number }
    api: { sendVoice: (chatId: number, voice: InputFile, other?: { duration?: number }) => Promise<unknown> }
  },
  fullText: string,
): void {
  if (!ELEVENLABS_API_KEY) return
  const wordCount = fullText.trim().split(/\s+/).length
  if (wordCount < SHORT_REPLY_WORDS) {
    log("info", "voice summary skipped — short reply", { wordCount, chatId: ctx.chat.id })
    return
  }

  const t0 = Date.now()
  const chatId = ctx.chat.id

  void (async () => {
    try {
      const tSummarize = Date.now()
      const { summary, source } = await summarizeForVoice(fullText)
      const summarizeLatencyMs = Date.now() - tSummarize

      if (!summary) {
        log("warn", "voice summary empty after summarize+fallback", { chatId })
        return
      }

      // Useless-fallback guard: when Sonnet times out and the fallback
      // grabs only the first sentence, that sentence is sometimes a
      // 2-word {{DA_NAME}} stylistic intro ("Busy day.", "Honestly?") rather
      // than the actual content. Voicing that against a long reply
      // produces a sub-1s "0:00" voice bubble — worse than no voice.
      const summaryWords = summary.trim().split(/\s+/).length
      if (
        source === "fallback" &&
        summaryWords < MIN_FALLBACK_WORDS &&
        wordCount >= MEANINGFUL_REPLY_WORDS
      ) {
        log("info", "voice summary skipped — useless fallback against long reply", {
          fallbackSummary: summary,
          fallbackWords: summaryWords,
          replyWords: wordCount,
          summarizeLatencyMs,
          chatId,
        })
        return
      }

      const tSynth = Date.now()
      const buf = await synthesizeKaiVoice(summary)
      const synthLatencyMs = Date.now() - tSynth

      const tSend = Date.now()
      await ctx.api.sendVoice(chatId, new InputFile(buf, "kai-summary.ogg"), {
        duration: oggOpusDurationSec(buf),
      })
      const sendLatencyMs = Date.now() - tSend

      lastVoiceSendMs = Date.now() - t0
      log("info", "voice summary sent", {
        summary,
        source,
        summaryLen: summary.length,
        summaryWords,
        summarizeLatencyMs,
        synthLatencyMs,
        sendLatencyMs,
        totalLatencyMs: lastVoiceSendMs,
        chatId,
      })
    } catch (err) {
      log("warn", "voice summary pipeline failed", {
        error: String(err).slice(0, 300),
        chatId,
      })
    }
  })()
}

/**
 * One-time cleanup of the prior ack-cache infrastructure from earlier session.
 * Removes the on-disk directory if present. Idempotent: subsequent boots no-op.
 */
async function cleanupStaleAckCache(): Promise<void> {
  try {
    await rm(STALE_ACK_CACHE_DIR, { recursive: true, force: true })
  } catch { /* nothing to clean is the happy path */ }
}

// ── Exports ──

/**
 * Start the Telegram bot polling loop.
 * Runs forever until stopTelegram() is called or parent terminates.
 */
// Baixa a foto/imagem da mensagem do Telegram pra um arquivo temporário e
// devolve o path, pro Jão ler com Read (visão via os olhos do SDK). Escolhe a
// maior variante de `photo` (array de tamanhos) ou um document com mime image/*.
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
    const path = `/tmp/tg-img-${ctx.message.message_id}.${ext}`
    await Bun.write(path, buf)
    return path
  } catch (err) {
    log("warn", "downloadTelegramImage failed", { error: String(err).slice(0, 200) })
    return null
  }
}

/** Content-type por extensão — o Groq valida o arquivo pela extensão do nome. */
const AUDIO_MIME_BY_EXT: Record<string, string> = {
  flac: "audio/flac", mp3: "audio/mpeg", mpeg: "audio/mpeg", mpga: "audio/mpeg",
  m4a: "audio/mp4", mp4: "audio/mp4", ogg: "audio/ogg", oga: "audio/ogg",
  opus: "audio/ogg", wav: "audio/wav", webm: "audio/webm",
}

/**
 * Transcreve um áudio via Groq Whisper (whisper-large-v3-turbo, pt). Telegram
 * manda voice notes em OGG/Opus, aceito direto. Devolve o texto (trim) ou lança.
 * Best-effort no chamador: falha aqui vira um aviso no chat, não derruba o bot.
 */
async function transcribeGroq(audio: Uint8Array, filename: string): Promise<string> {
  if (!GROQ_API_KEY) throw new Error("GROQ_API_KEY ausente no ambiente")
  const ext = filename.slice(filename.lastIndexOf(".") + 1).toLowerCase()
  const type = AUDIO_MIME_BY_EXT[ext] ?? "application/octet-stream"
  const form = new FormData()
  form.append("file", new Blob([audio], { type }), filename)
  form.append("model", GROQ_WHISPER_MODEL)
  form.append("language", "pt")
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
 * Baixa a voice note / arquivo de áudio da mensagem do Telegram pra um path em
 * /tmp e devolve metadados. Cobre `voice` (OGG/Opus), `audio` (arquivos/música,
 * carrega title/performer) e `document` com mime audio/*. Null se não for áudio.
 */
async function downloadTelegramAudio(
  ctx: any,
  token: string,
): Promise<{ path: string; filename: string; durationSec: number; label: string } | null> {
  const msg = ctx.message ?? {}
  let fileId: string | undefined
  let durationSec = 0
  let srcName = ""
  let label = ""
  if (msg.voice) {
    fileId = msg.voice.file_id
    durationSec = Number(msg.voice.duration ?? 0)
    srcName = "voice.ogg"
    label = "voice note"
  } else if (msg.audio) {
    fileId = msg.audio.file_id
    durationSec = Number(msg.audio.duration ?? 0)
    srcName = msg.audio.file_name || "audio.mp3"
    const parts = [msg.audio.performer, msg.audio.title].filter(Boolean)
    label = parts.length ? `arquivo de áudio — ${parts.join(" — ")}` : "arquivo de áudio"
  } else if (String(msg.document?.mime_type ?? "").startsWith("audio/")) {
    fileId = msg.document.file_id
    durationSec = 0   // documents don't carry duration; treated as long/unknown
    srcName = msg.document.file_name || "audio"
    label = "documento de áudio"
  }
  if (!fileId) return null
  try {
    const file = await ctx.api.getFile(fileId)
    if (!file.file_path) return null
    const res = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`)
    if (!res.ok) return null
    const buf = new Uint8Array(await res.arrayBuffer())
    // Extensão vem do file_path do Telegram (ex.: .oga pra voice); cai pra .ogg.
    const tgExt = String(file.file_path).split(".").pop()?.toLowerCase()
    const ext = tgExt && AUDIO_MIME_BY_EXT[tgExt] ? tgExt : (srcName.split(".").pop() || "ogg")
    // O Groq valida pela EXTENSÃO do nome do arquivo e aceita [flac mp3 mp4 mpeg
    // mpga m4a ogg opus wav webm] — mas NÃO "oga", que é como o Telegram nomeia
    // as voice notes (OGG/Opus). Normaliza a extensão do nome enviado (o conteúdo
    // é o mesmo); sem isso o Groq responde 400.
    const groqExt = ext === "oga" ? "ogg" : ext
    const path = `/tmp/tg-audio-${msg.message_id}.${ext}`
    await Bun.write(path, buf)
    return { path, filename: `audio.${groqExt}`, durationSec, label }
  } catch (err) {
    log("warn", "downloadTelegramAudio failed", { error: String(err).slice(0, 200) })
    return null
  }
}

/**
 * Baixa um `document` genérico do Telegram — PDF, CSV, OFX, planilha, JSON,
 * zip, .md, o que for — pra um path em /tmp, preservando o `file_name`
 * original (a extensão sai dele; cai pro file_path do Telegram se faltar).
 * Cobre só o que sobra depois de hasImage/hasAudio desviarem document com
 * mime image/* ou audio/* pros seus próprios handlers. Ao contrário do
 * downloadTelegramImage, loga a falha em vez de engolir — foi um `catch`
 * mudo igual a esse que deixou o Jão cego pra imagens em 2026-07-13.
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
    const path = `/tmp/tg-doc-${ctx.message.message_id}.${ext}`
    await Bun.write(path, buf)
    return { path, filename: originalName }
  } catch (err) {
    log("warn", "downloadTelegramDocument failed", { error: String(err).slice(0, 200) })
    return null
  }
}

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

  const allowedUsers = new Set(
    config.allowed_users?.length
      ? config.allowed_users
      : (process.env.TELEGRAM_ALLOWED_USERS ?? process.env.TELEGRAM_PRINCIPAL_CHAT_ID ?? "")
          .split(",")
          .map(s => s.trim())
          .filter(Boolean)
          .map(Number)
  )

  if (allowedUsers.size === 0) {
    log("error", "No allowed users configured")
    return
  }

  const maxTurns = config.max_turns ?? 25
  // Watchdog de INATIVIDADE no lugar do teto de parede (portado do bot vivo,
  // 2026-07-20): o timeout fixo ceifava turno LEGÍTIMO longo. Aborta só após
  // silêncio real do SDK, com hard cap absoluto como rede de segurança.
  const sdkInactivityMs = config.sdk_inactivity_ms ?? 180_000
  const sdkHardCapMs = config.sdk_hard_cap_ms ?? 900_000
  const editIntervalMs = config.edit_interval_ms ?? 800
  // Modelo + esforço do SDK (escolha do operador 2026-07-11): Opus 4.8 principal,
  // Sonnet 5 de fallback. Sobrescrevível pela TOML sem editar código.
  const sdkModel = config.model ?? "claude-opus-4-8"
  const sdkFallbackModel = config.fallback_model ?? "claude-sonnet-5"
  const sdkMaxThinkingTokens = config.max_thinking_tokens ?? 16000

  // Ensure directories
  await mkdir(STATE_DIR, { recursive: true })
  await mkdir(LOGS_DIR, { recursive: true })

  // Initialize conversation store
  conversationStore = new ConversationStore(join(STATE_DIR, "conversations.json"))
  await conversationStore.load()

  // One-time cleanup: the prior pre-cached ack-cache infrastructure has been
  // removed; sweep its on-disk artifacts so the state dir stays clean across
  // upgrades. Idempotent — second run finds nothing to clean.
  await cleanupStaleAckCache()

  log("info", "Voice summary pipeline ready", {
    voice_id: DA_VOICE_ID,
    summarizer_model: "sonnet",
    elevenlabs_key_present: ELEVENLABS_API_KEY !== "",
  })

  // Create bot
  activeConfig = config
  startedAt = Date.now()
  messagesReceived = 0
  messagesResponded = 0
  processing = false
  lastSessionId = undefined

  // Idle-session-boundary state: a fresh Pulse boot is a fresh thread by
  // definition. lastMessageAt = null means "no prior message in this process",
  // which the handler treats as "this is the first message in the thread".
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

  // Message handler — sequential processing
  bot.on("message", async (ctx) => {
    let text = ctx.message.text ?? ctx.message.caption ?? ""
    const userId = ctx.from.id
    const chatId = ctx.chat.id
    lastChatId = chatId   // alvo default do endpoint /api/telegram/send-voice

    // Imagem: baixa e injeta o path pro Jão ler com Read (visão pelos olhos do SDK).
    const hasImage = Array.isArray(ctx.message.photo) || String(ctx.message.document?.mime_type ?? "").startsWith("image/")
    if (hasImage) {
      const imgPath = await downloadTelegramImage(ctx, token)
      if (imgPath) {
        text = `[O __PRINCIPAL_NAME__ enviou uma imagem, salva em ${imgPath}. Use Read pra vê-la antes de responder.]${text ? `\nLegenda: ${text}` : ""}`
      }
    }
    // Áudio: voice note (comando por voz) ou arquivo/música. Transcreve via Groq.
    // Curto (≤5min) → a transcrição É a mensagem, segue o fluxo normal e eu respondo.
    // Longo (>5min) → modo arquivo: entendo do que se trata, arquivo a transcrição no
    // vault (commit+push) e subo o áudio pro Drive. O corte de autonomia do VPS já
    // libera vault+git. Sem integração de Drive neste ambiente.
    const hasAudio = ctx.message.voice || ctx.message.audio || String(ctx.message.document?.mime_type ?? "").startsWith("audio/")
    if (hasAudio && !hasImage) {
      const audio = await downloadTelegramAudio(ctx, token)
      if (audio) {
        await ctx.api.sendChatAction(chatId, "typing").catch(() => {})
        let transcript = ""
        try {
          transcript = await transcribeGroq(new Uint8Array(await Bun.file(audio.path).arrayBuffer()), audio.filename)
        } catch (err) {
          log("warn", "transcribeGroq failed", { error: String(err).slice(0, 200), durationSec: audio.durationSec })
          await ctx.reply("Não consegui transcrever esse áudio (Groq falhou). Tenta de novo ou manda por texto.")
          return
        }
        // duration 0 = documento de áudio sem metadado de duração → trata como longo/arquivo.
        const isLong = audio.durationSec > LONG_AUDIO_THRESHOLD_SEC || audio.durationSec === 0
        if (!isLong) {
          if (!transcript) { await ctx.reply("Áudio sem fala reconhecível — não transcrevi nada."); return }
          text = transcript   // a fala vira a mensagem; segue o pipeline normal e eu respondo
        } else {
          const tPath = `/tmp/tg-transcript-${ctx.message.message_id}.txt`
          await Bun.write(tPath, transcript || "(transcrição vazia — provável música ou áudio sem fala)")
          const mins = audio.durationSec ? Math.round(audio.durationSec / 60) : "?"
          text = [
            `[O __PRINCIPAL_NAME__ enviou um áudio longo (${audio.label}, ~${mins} min). NÃO é um comando pra executar — é material pra arquivar.`,
            `Áudio original salvo em: ${audio.path}`,
            `Transcrição completa salva em: ${tPath} (leia com Read).`,
            `Faça, nesta ordem:`,
            `1) Leia a transcrição e entenda em 1-2 linhas do que se trata (fala, reunião, ideia solta ou até música — se for música/sem fala, diga isso).`,
            `2) Arquive no vault: crie ${VAULT_DIR}/inbox/audios/<AAAA-MM-DD>-<slug>.md com frontmatter (source: telegram-audio, captured_at, duration_min, label) + o resumo + a transcrição; commit e push.`,
            `3) O áudio original fica salvo localmente em ${audio.path}. Não há integração de Google Drive neste ambiente — a transcrição arquivada no vault é o essencial.`,
            `4) Me responda com o resumo curto do que era + onde arquivou.]`,
          ].join("\n")
        }
      }
    }

    // Documento genérico: PDF, CSV, OFX, planilha, JSON, zip, .md — qualquer
    // `document` que não caiu em hasImage/hasAudio acima. Antes disso, TUDO que
    // não era foto nem áudio caía no chão sem log (buraco de projeto, não
    // regressão — pedido do operador 2026-07-13: "quero que você seja capaz de
    // receber qualquer coisa que eu mandar"). A Bot API do Telegram só deixa
    // baixar até 20MB — acima disso avisa em vez de tentar e falhar silencioso.
    const hasDocument = Boolean(ctx.message.document) && !hasImage && !hasAudio
    if (hasDocument) {
      const doc = ctx.message.document
      const MAX_BOT_API_BYTES = 20 * 1024 * 1024
      if (typeof doc.file_size === "number" && doc.file_size > MAX_BOT_API_BYTES) {
        log("warn", "document too large for Bot API download", {
          chatId, fileName: doc.file_name, fileSize: doc.file_size,
        })
        await ctx.reply(
          `Esse arquivo (${doc.file_name ?? "sem nome"}, ${(doc.file_size / 1024 / 1024).toFixed(1)}MB) passa do limite de 20MB que a API do Telegram libera pra bots baixarem. Manda por outro caminho (Drive, link) que eu leio de lá.`,
        )
        return
      }
      const docResult = await downloadTelegramDocument(ctx, token)
      if (docResult) {
        text = `[O __PRINCIPAL_NAME__ enviou um arquivo (${docResult.filename}), salvo em ${docResult.path}. Use Read pra abrir antes de responder — se for um binário que o Read não abre, me diga que tipo de arquivo é e o que fazer com ele.]${text ? `\nLegenda: ${text}` : ""}`
      } else {
        log("warn", "document received but download failed", {
          chatId, messageId: ctx.message.message_id, fileName: doc.file_name,
        })
        await ctx.reply("Recebi o arquivo mas o download falhou. Tenta reenviar.")
        return
      }
    }

    if (!text) return   // sem texto, imagem, áudio ou documento processável (sticker etc.) — ignora

    messagesReceived++
    log("info", "Message received", { userId, chatId, textLength: text.length, hasImage, hasDocument })

    // Sanitize input
    const sanitized = sanitize(text)
    if (!sanitized) return

    const injection = analyzeForInjection(sanitized)
    if (injection.riskLevel === "CRITICAL") {
      log("warn", "Blocked CRITICAL injection attempt", { userId, patterns: injection.matchedPatterns })
      await ctx.reply("Message blocked for security reasons.")
      return
    }

    // Toggle de voz (#7): "modo silencioso" / "modo voz" alternam o resumo falado
    // por-turno. Interceptado ANTES do SDK — é comando, não vira turno do agente.
    const voiceCmd = parseVoiceModeCommand(sanitized)
    if (voiceCmd !== null) {
      setVoiceEnabled(voiceCmd === "on")
      log("info", "voice mode toggled", { enabled: voiceCmd === "on", chatId })
      await ctx.reply(
        voiceCmd === "on"
          ? "🔊 Modo voz religado — volto a te mandar o áudio no fim de cada resposta. Manda \"modo silencioso\" pra desligar."
          : "🔇 Modo silencioso — paro de mandar áudio no fim das respostas. Manda \"modo voz\" pra religar. (A voz sob demanda, quando você pede explícito, continua funcionando.)",
      )
      return
    }

    // Sessão nova sob demanda (portado do bot vivo, 2026-07-20): conversas
    // densas engordam o contexto muito antes do corte por idle (60min), e não
    // havia como "dar um clear" à mão. Gatilhos EXATOS (mensagem inteira,
    // case-insensitive, com/sem acento). Clear TOTAL: sem recap, sem histórico.
    const isClearCmd = /^\s*(\/clear|\/nova|limpa a sess[aã]o|nova sess[aã]o|sess[aã]o nova|limpar sess[aã]o)\s*[.!]?\s*$/i.test(sanitized)
    if (isClearCmd) {
      lastSessionId = undefined
      lastMessageAt = null
      threadStartedAt = Date.now()
      log("info", "session cleared on demand", { chatId })
      await ctx.reply(`🧹 Sessão limpa. Próxima mensagem começa do zero: sem histórico, sem recap. (Também funciona: "nova sessão".)`).catch(() => {})
      return
    }

    // F7: intercept proposal replies BEFORE the SDK runs. `yes #id` / `no #id`
    // / `edit #id <text>` / `proposals` are handled directly without invoking
    // the agent. Anything else falls through to the normal SDK path.
    const proposalReply = parseProposalReply(sanitized)
    if (proposalReply.kind !== null) {
      const outcome = await handleProposalReply(chatId, proposalReply, ctx)
      if (outcome === "handled") {
        log("info", "Handled proposal reply", { kind: proposalReply.kind, chatId })
        return
      }
    }

    // Sequential processing — one message at a time
    if (processing) {
      await ctx.reply("Still processing your previous message. Please wait.")
      return
    }

    processing = true
    const startTime = Date.now()
    const now = Date.now()

    // Marca visual de "processando" (pedido do operador, 2026-07-14). O
    // Telegram expira a call "typing" depois de ~5s, então reemite em loop
    // pra cobrir o turno inteiro (que costuma levar bem mais que isso) — sem
    // isso a espera fica cega. Limpo no finally, sucesso ou erro do turno.
    const typingPing = () => { ctx.api.sendChatAction(chatId, "typing").catch(() => {}) }
    typingPing()
    const typingInterval = setInterval(typingPing, 4000)

    // Idle-session boundary: if the last successful exchange was more than
    // IDLE_TIMEOUT_MS ago, clear the SDK session and start a new thread. The
    // persisted conversations.json is unchanged — we just filter the history
    // injection below so the bot starts fresh.
    //
    // Order is load-bearing: this runs AFTER the sanitize-empty / injection-
    // CRITICAL / processing-busy early returns above, so garbage messages
    // never advance threadStartedAt or emit a spurious boundary log line.
    const isIdleReset = lastMessageAt !== null && (now - lastMessageAt) > IDLE_TIMEOUT_MS
    if (isIdleReset) {
      // Capture into a const BEFORE we clear it, so the log line reports the
      // session ID we're abandoning, not undefined.
      const prevSessionId = lastSessionId
      log("info", "thread boundary — fresh session", {
        idleMs: now - lastMessageAt!,
        prevSessionId,
        newThreadStartedAt: now,
      })
      lastSessionId = undefined
      threadStartedAt = now
    }

    try {
      // Build per-turn LifeOS memory context — who {{PRINCIPAL_NAME}} is, who {{DA_NAME}} is, what
      // {{PRINCIPAL_NAME}}'s goals are, what's in flight today, AND any relevant prior
      // memory pulled by BM25 against the current message.
      const contextBlock = await buildPaiContextBlock(sanitized)

      // Build prompt with conversation history context, scoped to the current
      // thread only. After an idle reset, threadStartedAt is "now" and this
      // filter returns an empty list — so the prompt omits the "Previous
      // conversation:" prefix entirely, giving the SDK a clean start.
      const history = conversationStore!.getHistory()
        .filter(m => m.timestamp >= threadStartedAt)
      let prompt = sanitized
      if (history.length > 0) {
        const historyText = history
          .slice(-10) // Last 5 exchanges for context
          .map(m => `${m.role === "user" ? "Principal" : "DA"}: ${m.content}`)
          .join("\n")
        prompt = `Previous conversation:\n${historyText}\n\nPrincipal's new message: ${sanitized}`
      }

      const sdkOptions: Record<string, unknown> = {
        cwd: CWD,
        // Modelo mais inteligente + esforço alto (ver consts no topo de startTelegram).
        // Antes: sem `model` → default do harness (Sonnet 4.5). Agora Opus 4.8 na assinatura.
        model: sdkModel,
        fallbackModel: sdkFallbackModel,
        maxThinkingTokens: sdkMaxThinkingTokens,
        // Headless: não há UI de permissão no Telegram, então o permission system
        // default trava toda Write/Bash. Autorizado explicitamente pelo operador
        // (2026-07-10): o canUseTool abaixo é o gate único deste agente — implementa
        // o corte vault↔motor, bloqueia destrutivos/notify, e o bot só atende o
        // chat_id do principal. bypassPermissions desliga só os prompts nativos.
        permissionMode: "bypassPermissions",
        tools: { type: "preset", preset: "claude_code" },
        // AskUserQuestion é UI de terminal interativo — no Telegram não existe
        // essa UI, a chamada trava esperando resposta que nunca chega e o turno
        // congela (bug confirmado no bot vivo, 2026-07-20). Fora do tool set;
        // pergunta vai em texto simples na própria resposta.
        disallowedTools: ["AskUserQuestion"],
        settingSources: ["user", "project"],  // NO "local" — skip CLAUDE.md to avoid Algorithm/format/voice curls
        // Channel marker — propagated to every hook in the SDK subprocess
        // tree. VoiceCompletion / StopFailureHandler / PromptProcessing /
        // DocCrossRefIntegrity all check LIFEOS_NOTIFICATION_CHANNEL and skip
        // their localhost:31337/notify fetch when it is not "desktop". The
        // voice for this turn is delivered via bot.api.sendVoice below
        // (sendVoiceSummary fire-and-forget).
        // Source of truth: hooks/lib/notification-channel.ts.
        env: { ...process.env, LIFEOS_NOTIFICATION_CHANNEL: "telegram" },
        // Hard-block /notify via canUseTool callback. Bash calls containing
        // "31337" or "/notify" are denied at the SDK permission boundary.
        // This is a belt-and-suspenders backup to the env-var channel gate
        // above; the env gate stops desktop voice at the hook level (where
        // it actually fires), the canUseTool block stops the model from
        // curl-ing /notify directly if it ever tried.
        maxTurns,
        includePartialMessages: true,
        canUseTool: (toolName: string, input: unknown) => {
          const obj = (typeof input === "object" && input !== null) ? input as Record<string, unknown> : {}
          // Cinto-e-suspensório do disallowedTools acima: se a chamada aparecer
          // mesmo assim, nega com redirect em vez de travar o turno.
          // (Shape { result, reason } = SDK 0.1.x do motor-base; ao atualizar o
          // tarball pro SDK 0.3.x, converter TODOS os retornos pra { behavior, message }.)
          if (toolName === "AskUserQuestion") {
            log("warn", "canUseTool blocked AskUserQuestion on Telegram", {})
            return { result: "deny", reason: "AskUserQuestion não existe no Telegram (a chamada travaria o turno). Faça a pergunta em texto simples na sua resposta." }
          }
          // OLHOS — ferramentas read-only sempre liberadas (ancorar na fonte).
          const READONLY = new Set(["Read", "Grep", "Glob", "LS", "NotebookRead", "WebFetch", "WebSearch", "TodoWrite"])
          if (READONLY.has(toolName)) return { result: "allow" }
          // BASH — libera (git, scripts, python), menos /notify+31337 e destrutivos.
          if (toolName === "Bash") {
            const cmd = "command" in obj ? String(obj.command) : String(input)
            // Bloqueia /notify (voz no alto-falante do desktop, que o operador não
            // ouve no celular) e a porta 31337 — EXCETO o endpoint send-voice, que
            // é justamente o canal legítimo pra postar voz custom no Telegram.
            const isSendVoice = cmd.includes("/api/telegram/send-voice")
            if (cmd.includes("/notify") || (cmd.includes("31337") && !isSendVoice)) {
              log("warn", "canUseTool blocked /notify curl from SDK subprocess", { cmd: cmd.slice(0, 200) })
              return { result: "deny", reason: "Telegram mode: /notify e porta 31337 bloqueados (voz custom vai por /api/telegram/send-voice)." }
            }
            if (/\brm\s+-rf?\b|\bmkfs\b|\bdd\s+if=|\bshutdown\b|\breboot\b|>\s*\/(etc|boot|dev)\b|:\(\)\s*\{\s*:/.test(cmd)) {
              log("warn", "canUseTool blocked destructive Bash from Telegram", { cmd: cmd.slice(0, 200) })
              return { result: "deny", reason: "Comando destrutivo bloqueado no Telegram. Peça no desktop, com supervisão." }
            }
            return { result: "allow" }
          }
          // ESCRITA — auto no VAULT (cérebro do operador: processar inbox, editar
          // verbetes, melhorar scripts do repo) e na MEMÓRIA do Jão. Bloqueia só o
          // CÓDIGO/CONFIG do sistema LifeOS (~/.claude/hooks, PULSE, TOOLS, settings)
          // — foi onde o bot alucinou hoje (patch Express); isso fica pra supervisão
          // no desktop. Ao mexer no vault, comitar+pushar logo (evita divergência).
          if (toolName === "Write" || toolName === "Edit" || toolName === "MultiEdit") {
            const p = String(obj.file_path ?? obj.path ?? "")
            const AUTO = p.includes("/vault/") || p.includes("/.claude/LIFEOS/MEMORY/")
            if (AUTO) return { result: "allow" }
            log("info", "canUseTool: write to system code denied on Telegram (needs desktop)", { tool: toolName, path: p })
            return { result: "deny", reason: `Isso é código/config do sistema LifeOS (${p}) — no Telegram eu proponho, mas aplicar mexe no próprio motor e fica pro desktop, com supervisão (foi aí que eu aluciney hoje). No vault e na memória eu edito direto.` }
          }
          return { result: "allow" }
        },
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          append: `\n\n${contextBlock}\n\n## TELEGRAM MODE — HOW YOU RESPOND

You are {{DA_NAME}}, responding to {{PRINCIPAL_NAME}} via Telegram from his phone. The LifeOS CONTEXT block above is refreshed every turn — use it. {{PRINCIPAL_NAME}} is reading on a phone, possibly walking, possibly with AirPods in. After your text reply ships, the system will summarize your reply and send {{PRINCIPAL_NAME}} a voice note in your voice — so what you say matters audibly, not just visually.

### TELEGRAM_DIRECTIVE (OVERRIDES CLAUDE.md mode-template rule)

EffortRouter has injected a TELEGRAM_DIRECTIVE in this turn's additionalContext. That directive replaces the constitutional "every response uses MINIMAL/NATIVE/ALGORITHM template" rule for this surface. The terminal modes are for the terminal — Telegram is a chat surface and uses plain conversational prose.

DO NOT emit ANY of these:
- Mode banner labels: bare "MINIMAL", "NATIVE", "ALGORITHM" on a line of their own
- Box dividers: \`═══ LifeOS ═══════════════════════════\` or any \`═══\` line
- Algorithm phase headers: \`━━━ 👁️ OBSERVE ━━━ 1/7\` and equivalents
- Template field prefixes: \`📃 CONTENT:\`, \`🔧 CHANGE:\`, \`✅ VERIFY:\`, \`📋 SUMMARY:\`, \`🗒️ TASK:\`, \`🔄 ITERATION:\`, \`🖊️ STORY:\`, \`🗣️ {{DA_NAME}}:\`
- Any other formatting scaffolding from CLAUDE.md mode templates

A belt-and-suspenders egress sanitizer (LIFEOS/PULSE/lib/strip-mode-scaffolding.ts) catches any of these markers and strips them before the message ships — but cleaner to never emit them in the first place. If the sanitizer fires on your output that's a leak telemetry signal.

### How you write
- Lead with the answer. No preamble, no "Great question", no "So basically".
- Speak as {{DA_NAME}} — precise, fast, low-ego, dryly opinionated. Match the voice in DA_IDENTITY above.
- Reference {{PRINCIPAL_NAME}}'s context — projects, people, TELOS — when it makes the answer sharper. Don't shoehorn.
- Keep replies under 200 words. Phone reading. No walls of text.
- No code blocks unless {{PRINCIPAL_NAME}} explicitly asks for code.
- No git jargon with {{PRINCIPAL_NAME}} ("commit", "push", "repository", "branch"): say "salvei localmente", "sincronizei", "fiz backup". Versioning mechanics stay under the hood.

### What you do
- Use tools. Read files, run skills, send messages, hit APIs — don't ask permission for read-only or self-scoped actions.
- Questions to the principal go as PLAIN TEXT inside your reply — the interactive AskUserQuestion tool does not exist on this surface (calling it freezes the turn) and is blocked.
- **Áudio sob demanda:** o resumo falado de cada turno já sai sozinho — NÃO faça nada pra ele. Mas quando {{PRINCIPAL_NAME}} pedir EXPLICITAMENTE a resposta em voz ("me responde em áudio", "grava um áudio disso", "manda por voz", "me conta isso falando") — ou pedir pra sintetizar um recado pra ele encaminhar — poste a voz custom você mesmo com: \`curl -sS -X POST http://localhost:31337/api/telegram/send-voice -H "Content-Type: application/json" -d '{"text": "O TEXTO COMPLETO A SER FALADO, em pt-BR"}'\`. O chatId resolve sozinho (último chat ativo). Este é o ÚNICO uso permitido da porta 31337 — /notify segue terminantemente proibido.
- If {{PRINCIPAL_NAME}} asks "what should I work on", give an opinion grounded in his TELOS and active sessions. Pick one. Defend it briefly.
- If something requires destructive or shared action (deploy, push, send external email), confirm before doing it.
- If you don't know, say so concretely in one sentence. Don't pad.

### What NOT to do
- **NEVER, under any circumstance, call \`curl http://localhost:31337/notify\` or hit port 31337 or any /notify endpoint.** {{PRINCIPAL_NAME}} is reading your reply on his phone via Telegram. The Pulse /notify endpoint plays audio out of his laptop speaker. He will not hear it. The voice you produce here is delivered by the Telegram \`sendVoice\` API as a voice-message bubble in the chat — that pipeline runs AFTER your reply ships and you do not invoke it. If you find yourself reaching for Bash to curl /notify, stop. The voice has already been arranged.
- Do not narrate the LifeOS CONTEXT block above. It's for you, not {{PRINCIPAL_NAME}} — he wrote half of it.
- Do not invent project names, people, dates. If unsure, check the context block or the files directly.

### YOUR ROLE HERE + THE CUT (o que você faz direto vs. o que fica pro admin)
- You have EYES: Read, Grep, Glob work — and using them is MANDATORY. Ancore na fonte: before opining on any file, code, or structure, READ it. Never describe what you imagine; read it. NUNCA afirme ter acesso a arquivos, repositórios ou ferramentas sem antes verificar que existem de verdade neste ambiente — se não checou, não afirme.
- O vault do __PRINCIPAL_NAME__ (o segundo cérebro dele) fica em ~/vault e **começa vazio** — cresce com o uso, conforme o __PRINCIPAL_NAME__ traz material e você organiza. O motor do LifeOS fica em ~/.claude. **NÃO existe nenhum outro vault, pasta pessoal, nem repositório de terceiros neste ambiente. NÃO há \`gh\` instalado, nem \`tarefas.py\`, nem venv de terceiros, nem integração de Google Drive. Se você não vê em ~/vault ou ~/.claude, não existe aqui.**
- YOU DO DIRECTLY (content & knowledge): consulte e organize tudo em ~/vault; edite/melhore as notas do __PRINCIPAL_NAME__; write memory. Quando houver repositório configurado e você mudar o vault, git add + commit + push logo em seguida.
- ONLY WITH THE ADMIN (o motor): editar ~/.claude system code/config — hooks, PULSE, TOOLS, ALGORITHM, settings, .ts files. Aí você PROPÕE, o admin aplica. Regra: **conteúdo e conhecimento → você pode; o motor que roda o LifeOS → só com o admin no loop.**`,
        },
      }

      // Resume previous session for context continuity
      if (lastSessionId) {
        sdkOptions.resume = lastSessionId
      }

      const conversation = query({ prompt, options: sdkOptions as any })

      // Collect response with timeout
      let fullText = ""
      let messageId: number | null = null
      let lastEditTime = 0

      const timeoutController = new AbortController()
      // Dois gatilhos de abort (portado 2026-07-20, no lugar do teto de parede):
      // (1) inatividade — rearmado a cada evento do SDK; (2) hard cap absoluto.
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

          // Capture session ID for resume
          if (msg.type === "system" && msg.subtype === "init" && msg.session_id) {
            lastSessionId = msg.session_id
            log("info", "Session initialized", { sessionId: lastSessionId })
          }

          // Streaming text deltas (progressive updates)
          if (msg.type === "stream_event" && msg.event?.type === "content_block_delta" &&
              msg.event?.delta?.type === "text_delta" && msg.event.delta.text) {
            fullText += msg.event.delta.text
          }

          // Full assistant message (fallback if streaming not available)
          if (msg.type === "assistant" && Array.isArray(msg.message?.content)) {
            for (const block of msg.message.content) {
              if (block.type === "text" && block.text) {
                if (!fullText) fullText = block.text
              }
            }
          }

          // Final result
          if (msg.type === "result") {
            if (msg.subtype === "success" && msg.result) {
              fullText = msg.result
            }
            if (msg.session_id) lastSessionId = msg.session_id
            log("info", "SDK session complete", {
              durationMs: Date.now() - startTime,
              numTurns: msg.num_turns,
              cost: msg.total_cost_usd,
              sessionId: lastSessionId,
            })
          }

          // Live edit updates in Telegram
          const now = Date.now()
          if (fullText && now - lastEditTime >= editIntervalMs) {
            const displayText = fullText.slice(0, MAX_TELEGRAM_LENGTH - 10) + CURSOR
            try {
              if (!messageId) {
                const sent = await ctx.reply(displayText)
                messageId = sent.message_id
              } else {
                await ctx.api.editMessageText(chatId, messageId, displayText).catch(() => {})
              }
              lastEditTime = now
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
          fullText = "Sorry, I wasn't able to generate a response. Try again?"
          log("error", "Empty response from SDK")
        }
      }

      // Egress sanitizer. Strip any CLAUDE.md mode
      // scaffolding the model leaked despite the TELEGRAM_DIRECTIVE override
      // (EffortRouter additionalContext + system-prompt override). Defense in
      // depth — Layer 1 (directive) is primary; this is Layer 2. Log on hit
      // so we can tune the directive when leaks happen.
      // Source: LIFEOS/PULSE/lib/strip-mode-scaffolding.ts.
      if (hasModeScaffolding(fullText)) {
        const before = fullText
        fullText = stripModeScaffolding(fullText)
        log("warn", "egress sanitizer stripped mode scaffolding", {
          beforeLen: before.length,
          afterLen: fullText.length,
          beforeFirstLine: before.split("\n")[0]?.slice(0, 80),
        })
      }

      // Final clean message — fatia em fronteira de parágrafo/linha (nunca no
      // meio da palavra/tag), renderiza CADA chunk em HTML (negrito/itálico/
      // código/links), com fallback pra texto plano por chunk se o Telegram
      // rejeitar o parse. Unifica o caminho curto e o caminho longo — antes só
      // o caminho ≤4096 passava por mdToTelegramHtml, e o split cego mandava
      // texto plano sem parse_mode, perdendo toda formatação.
      const chunks = splitForTelegram(fullText)
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
      await sendChunk(chunks[0]!, messageId)
      for (const chunk of chunks.slice(1)) {
        await sendChunk(chunk)
      }

      messagesResponded++
      log("info", "Response sent", { durationMs: Date.now() - startTime, responseLength: fullText.length })

      // Persist conversation
      await conversationStore!.addExchange(sanitized, fullText)
      await appendChatLog(sanitized, fullText)

      // Mark this thread as alive. Updated ONLY here (after a successful
      // exchange) — not at handler entry — so a slow SDK reply doesn't reset
      // the idle clock for an interleaved second message.
      lastMessageAt = now

      // Fire-and-forget voice summary. Sonnet summarizes the reply into ≤2
      // sentences in {{DA_NAME}}'s voice, ElevenLabs synthesizes it, Telegram delivers
      // it as a voice-message bubble. Never awaited — must not block the
      // `processing = false` release in `finally`.
      // #7: só dispara se o modo voz estiver ligado (toggle "modo silencioso").
      if (isVoiceEnabled()) sendVoiceSummary(ctx, fullText)

      // F7: piggy-back ONE pending identity proposal onto this turn's reply.
      // Rate-limited to one per turn so the chat doesn't get spammed when the
      // reviewer enqueues multiple proposals between messages.
      drainPendingProposals(chatId, 1).catch((e) => {
        log("warn", "drainPendingProposals failed", { error: String(e) })
      })

    } catch (err) {
      log("error", "Message processing failed", { error: String(err) })
      await ctx.reply("Something went wrong processing your message. Try again?").catch(() => {})
    } finally {
      clearInterval(typingInterval)
      processing = false
    }
  })

  // Start polling — await keeps startTelegram() alive until bot.stop() is called.
  // Without await, the supervisor thinks the function exited and restarts it,
  // causing a grammY 409 conflict (two polling loops on the same bot token).
  log("info", "Starting Telegram polling", { allowedUsers: [...allowedUsers] })

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
 * Return health status for the parent's /health endpoint.
 */
export function telegramHealth(): {
  status: "running" | "stopped" | "disabled"
  uptime_ms: number
  messages_received: number
  messages_responded: number
  processing: boolean
  last_session_id?: string
  voice_summary: { enabled: boolean; last_send_ms: number | null }
} {
  const voice_summary = { enabled: ELEVENLABS_API_KEY !== "", last_send_ms: lastVoiceSendMs }

  if (!bot) {
    return {
      status: activeConfig?.enabled === false ? "disabled" : "stopped",
      uptime_ms: 0,
      messages_received: 0,
      messages_responded: 0,
      processing: false,
      voice_summary,
    }
  }

  return {
    status: "running",
    uptime_ms: Date.now() - startedAt,
    messages_received: messagesReceived,
    messages_responded: messagesResponded,
    processing,
    last_session_id: lastSessionId,
    voice_summary,
  }
}
