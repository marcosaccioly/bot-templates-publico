/**
 * telegram-repobot.ts — Bot conversacional de __CLIENT_NAME__ (@__BOT_HANDLE__). Template repo-bot v2 (23/11/2026, a partir do tenant-e ← tenant-d).
 * Versão CONTAINER (canônica) — roda standalone via run.ts, sem Pulse.
 *
 * Isolamento por construção (lição tenant-b):
 *   - nenhuma identidade de principal; o "cérebro" é o repo __VAULT_REPO_NAME__ (vault)
 *   - settingSources: só "project" (CLAUDE.md do vault)
 *   - env do subprocess SDK minimizado; escrita restrita ao vault
 *   - tudo que é instância vem de env:
 *       TELEGRAM_BOT_TOKEN        token do BotFather (obrigatório)
 *       TELEGRAM_ALLOWED_USERS    csv de chat_ids (DM)
 *       TELEGRAM_ALLOWED_GROUPS   csv de chat_ids de grupos liberados (negativos);
 *                                 em grupo o bot só responde a menção/reply/comando
 *       VAULT_DIR                 default $HOME/vault
 *       GROQ_API_KEY                     transcrição de áudio
 *       ELEVENLABS_API_KEY + BOT_VOICE_ID   voz de saída (lib/voice.ts)
 *       CLAUDE_CODE_OAUTH_TOKEN          billing da assinatura
 */

import { Bot, InlineKeyboard, InputFile } from "grammy"
import { query } from "@anthropic-ai/claude-agent-sdk"
import { ConversationStore } from "./lib/conversation"
import { sanitize } from "./lib/sanitize"
import { mdToTelegramHtml } from "./lib/telegram-format"
import { resolveSpeaker, speakerContextLine } from "./lib/identity"
import { reactionsEnabled, receiptReaction, splitReactMarker } from "./lib/reactions"
import { resolveAttachment, splitSendMarkers } from "./lib/attachments"
import * as fwd from "./lib/encaminhar"
import { voiceEnabled, sendVoiceSummary, spokenVoiceEnabled, splitSpeakBlocks, sendSpokenText } from "./lib/voice"
import { join } from "path"
import { appendFile, mkdir, writeFile } from "fs/promises"
import { existsSync } from "fs"

// ── Config ────────────────────────────────────────────────────────────────────

const HOME = process.env.HOME ?? "/home/__TENANT__"
const VAULT = process.env.VAULT_DIR ?? join(HOME, "vault")
const STATE_DIR = join(HOME, "state", "telegram")
const LOGS_DIR = join(HOME, "logs", "telegram")
const LOG_FILE = join(LOGS_DIR, "telegram-repobot.log")
// Envios para outra pessoa (ENVIAR PARA / RECADO PARA / /encaminhar): uma linha
// por evento, sem chat_id.
const ENVIOS_LOG = join(LOGS_DIR, "envios-para-outros.jsonl")
const MEDIA_TMP = "/tmp/__TENANT__-media"

const GROQ_API_KEY = process.env.GROQ_API_KEY ?? ""
const GROQ_TRANSCRIPTION_URL = "https://api.groq.com/openai/v1/audio/transcriptions"
const GROQ_WHISPER_MODEL = "whisper-large-v3-turbo"

const LONG_AUDIO_SEC = 10 * 60          // >10min = "áudio longo" → arquiva, processa com calma
const IDLE_BOUNDARY_MS = 60 * 60 * 1000 // 60min sem mensagem = thread nova
const MAX_MSG_CHARS = 4000              // teto do sendMessage é 4096
const STREAM_EDIT_MS = 900              // throttle do editMessageText durante o streaming
const STREAM_MIN_CHARS = 60             // só começa a streamar com um mínimo de texto
const STATUS_EDIT_MS = 1200            // throttle da linha de status de ferramenta (🔧)
const BATCH_SETTLE_MS = 1500           // espera a rajada assentar (2 encaminhadas, texto + pedido, álbum) antes do turno
const MAX_QUOTE_CHARS = 3500           // teto do texto citado num reply — o original inteiro costuma ser o pedido
const MAX_QUOTE_BOT_CHARS = 500        // reply a mensagem do próprio bot: só um trecho (a resposta já está no histórico)

/** Rótulo amigável (pt) do que o bot está fazendo ao usar uma ferramenta. */
function toolStatusLabel(name: string): string {
  const map: Record<string, string> = {
    Read: "🔎 consultando os registros…",
    Grep: "🔎 procurando nos registros…",
    Glob: "🔎 procurando…",
    LS: "🔎 olhando o que a gente tem…",
    Bash: "⏳ conferindo…",
    Write: "✍️ guardando…",
    Edit: "✍️ anotando…",
    MultiEdit: "✍️ anotando…",
    WebFetch: "🌐 buscando lá fora…",
    WebSearch: "🌐 pesquisando…",
  }
  return map[name] ?? "⏳ um instante…"
}

export interface TelegramRepoBotConfig {
  enabled: boolean
  model?: string
  fallback_model?: string
  max_turns?: number
  /** Aborta o turno após este silêncio REAL do SDK (rearmado a cada evento). Substitui o antigo sdk_timeout_ms de parede, que ceifava turno legítimo longo. */
  sdk_inactivity_ms?: number
  /** Rede de segurança absoluta pro turno inteiro, trabalhando ou não. */
  sdk_hard_cap_ms?: number
  max_thinking_tokens?: number
}

// ── Estado do módulo ──────────────────────────────────────────────────────────

let bot: Bot | null = null
let conversationStore: ConversationStore | null = null
// Lock POR CHAT (fix paralelismo 2026-09-15): um grupo grande segue
// um-turno-por-vez, mas não trava mais os privados (e vice-versa).
const processingByChat = new Map<number, boolean>()
// Fila POR CHAT (fix 2026-09-15): mensagem que chega durante um turno — ou na
// mesma rajada (duas encaminhadas, texto + pedido) — não é mais descartada com
// "Um instante"; entra no próximo lote, e o lote inteiro vira UM turno.
type PendingMsg = { ctx: any; text: string; contexto: string }
const pendingByChat = new Map<number, PendingMsg[]>()
const settleTimerByChat = new Map<number, ReturnType<typeof setTimeout>>()
let lastSessionId: string | undefined
let lastMessageAt: number | null = null
let startedAt = 0
let messagesReceived = 0
let messagesResponded = 0
let gitQueue: Promise<unknown> = Promise.resolve()

function log(level: string, msg: string, extra?: Record<string, unknown>) {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...extra })
  appendFile(LOG_FILE, line + "\n").catch(() => {})
  console.log(`[__TENANT__-bot] ${level}: ${msg}`)
}

export function telegramRepoBotHealth() {
  return {
    status: bot ? "ok" : "down",
    started_at: startedAt ? new Date(startedAt).toISOString() : null,
    messages_received: messagesReceived,
    messages_responded: messagesResponded,
    vault: VAULT,
  }
}

// ── Captura → inbox/raw (append-only) + git ──────────────────────────────────

function tsParts(d = new Date()) {
  const pad = (n: number) => String(n).padStart(2, "0")
  return {
    dia: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    hora: `${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`,
  }
}

/** Serializa operações git (evita corridas entre capturas concorrentes). */
function gitCommitPush(message: string) {
  gitQueue = gitQueue.then(async () => {
    const run = (args: string[]) =>
      Bun.spawnSync(["git", "-C", VAULT, ...args], { stdout: "pipe", stderr: "pipe" })
    run(["add", "-A"])
    run(["commit", "-m", message]) // pode não ter nada staged — ok
    // Push SEMPRE que houver commit local sem subir — inclusive quando o
    // próprio agente commitou no meio do turno (aí o commit acima vira no-op
    // e o antigo `return` deixava o commit preso: 23/09, troca "Nascida no
    // Espírito Santo" dita como feita e nunca publicada).
    const ahead = new TextDecoder().decode(
      run(["rev-list", "--count", "@{u}..HEAD"]).stdout).trim()
    if (ahead === "0") return
    let p = run(["push"])
    if (p.exitCode !== 0) {
      // Push rejeitado (o remoto avançou — ex.: eu mexi no repo). Integra os
      // commits remotos POR BAIXO dos locais e re-tenta, pra não deixar commit
      // preso e a divergência crescer (auto-recuperação, pedido Marquito 22/08).
      const rb = run(["pull", "--rebase", "origin", "main"])
      if (rb.exitCode !== 0) {
        run(["rebase", "--abort"]) // conflito real → não trava o repo; commit fica local
        log("warn", "git pull --rebase falhou (conflito?) — commit fica local, resolver manual", {
          err: new TextDecoder().decode(rb.stderr).slice(0, 200),
        })
        return
      }
      p = run(["push"])
      if (p.exitCode !== 0) {
        log("warn", "git push falhou mesmo após rebase — fica pro próximo ciclo", {
          err: new TextDecoder().decode(p.stderr).slice(0, 200),
        })
      } else {
        log("info", "git push recuperado após rebase")
      }
    }
  }).catch(err => log("warn", "gitCommitPush error", { error: String(err).slice(0, 200) }))
  return gitQueue
}

async function saveRaw(msgId: number, kind: string, body: string, extraFm = ""): Promise<string> {
  const { dia, hora } = tsParts()
  const dir = join(VAULT, "inbox", "raw", dia)
  await mkdir(dir, { recursive: true })
  const rel = `inbox/raw/${dia}/${hora}-${msgId}.md`
  const fm = `---\nsource: telegram-repobot\nkind: ${kind}\ncaptured_at: "${new Date().toISOString()}"\nmessage_id: ${msgId}\n${extraFm}---\n\n`
  await writeFile(join(VAULT, rel), fm + body + "\n")
  gitCommitPush(`[bot/raw] captura ${kind} msg ${msgId}`)
  return rel
}

// ── Mídia ─────────────────────────────────────────────────────────────────────

async function downloadFile(token: string, fileId: string, destPath: string): Promise<boolean> {
  try {
    const info = await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`)
    const j = (await info.json()) as { ok: boolean; result?: { file_path?: string } }
    if (!j.ok || !j.result?.file_path) return false
    const res = await fetch(`https://api.telegram.org/file/bot${token}/${j.result.file_path}`)
    if (!res.ok) return false
    await Bun.write(destPath, await res.arrayBuffer())
    return true
  } catch (err) {
    log("warn", "downloadFile failed", { error: String(err).slice(0, 200) })
    return false
  }
}

async function transcribeGroq(path: string, filename: string): Promise<string> {
  if (!GROQ_API_KEY) throw new Error("GROQ_API_KEY ausente")
  const buf = new Uint8Array(await Bun.file(path).arrayBuffer())
  const form = new FormData()
  form.append("file", new Blob([buf], { type: "audio/ogg" }), filename)
  form.append("model", GROQ_WHISPER_MODEL)
  form.append("language", "pt")
  form.append("response_format", "json")
  const res = await fetch(GROQ_TRANSCRIPTION_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${GROQ_API_KEY}` },
    body: form,
    signal: AbortSignal.timeout(120_000),
  })
  if (!res.ok) throw new Error(`Groq ${res.status}: ${(await res.text().catch(() => "")).slice(0, 150)}`)
  return String(((await res.json()) as { text?: string }).text ?? "").trim()
}

// ── O turno do agente ────────────────────────────────────────────────────────

// A alma do @__BOT_HANDLE__. Base estática; a cada turno é concatenada a linha
// "Quem está falando agora" (ver runAgentTurn), resolvida pelo BOT_ROSTER do env.
const SYSTEM_APPEND = `

## VOCÊ É O ASSISTENTE DE __CLIENT_NAME__ (__PROJECT_NAME__)

Você conversa pelo Telegram com a equipe de __CLIENT_NAME__ e com __PRINCIPAL_NAME__
(operador) — a linha "Quem está falando agora" diz quem é. Antes de tudo você é
alguém para CONVERSAR — leve, útil, sem burocracia. Seu mundo é o repositório em
${VAULT}: o CLAUDE.md dele é o seu mapa (estrutura, roteamento, fontes de verdade,
o que carregar em cada tarefa). Você não é o assistente pessoal de ninguém; é o
par de trabalho do projeto.

### Regras duras
- [PERSONALIZE] Dado sensível: o que PODE circular nesta conversa e o que NUNCA
  pode (ex.: dado de paciente, valores de contrato, dados de terceiros). Se algo
  proibido chegar, NÃO guarde, explique gentilmente e avise o operador.
- [PERSONALIZE] Fronteira de escopo: o que você NÃO decide (clínico, jurídico,
  financeiro…) — pode organizar informação, mas a decisão é de quem é.
- [PERSONALIZE] Pastas congeladas/imutáveis do cliente. \`inbox/raw/\` é sempre
  imutável (é do sistema; você não escreve lá).

### Como você responde
- Português, direto, curto (a pessoa lê no celular). NUNCA use tabela markdown
  — o Telegram não renderiza. Liste uma linha por item. Bloco de código só se pedirem.
- ANCORE NA FONTE: antes de afirmar fato, número ou nome, leia o arquivo no
  repositório. Nunca invente. Se não achou, diga que não achou e onde procurou.
- Com a equipe: ZERO jargão técnico (git, commit, repositório, arquivo, pasta,
  inbox, servidor, "ferramenta"). Fale "anotei", "guardei", "dei uma olhada no que
  a gente já tem". Só explique a mecânica se pedirem. Com o operador pode ser técnico.
- [PERSONALIZE] Voz para texto público, se o repo tiver (ex.: \`voice/\`).

### O que você faz
- **Conversa e consulta**: [PERSONALIZE] aponte cada tipo de pergunta pro
  arquivo/pasta que é fonte de verdade.
- **Guardar de propósito** (nada é capturado sozinho, exceto anexo e áudio longo):
  - conversa/pergunta → responda e pronto, não salve.
  - MATERIAL (relato de reunião, contato novo, ideia, dado, decisão) → guarde no
    lugar certo, seguindo o roteamento do CLAUDE.md; na dúvida do lugar, em
    \`inbox/suggested/\` para triagem. Sempre registre QUEM trouxe e QUANDO
    ("— trazido por Fulana, DD/MM"). Depois diga numa linha, sem jargão, o que guardou.
  - em dúvida se vale guardar → SUGIRA ("isso parece uma decisão — guardo?") e
    só grave se confirmarem.
- **Trabalho maior**: [PERSONALIZE] siga o fluxo/stage correspondente do repo.
  Versão de documento nunca se sobrescreve — crie a próxima.
- Nunca apague material antigo. Corrigir = acrescentar ou editar com cuidado.

### Em grupo
Num grupo você só é acordado quando te chamam (@menção, seu nome, reply a uma
mensagem sua ou comando) — o resto da conversa não chega até você. Responda a
quem chamou, pelo nome; não presuma que sabe o que foi dito antes no grupo.

### Fechar com reação (opcional)
Quando a mensagem chega, o sistema já reage sozinho pra dizer "recebi". Se no fim
do turno algo concreto aconteceu, você pode TROCAR essa reação fechando a resposta
com uma linha só, no fim:
REACT:<emoji>
Use pelo que DE FATO aconteceu: ✍ (guardei) · 👌 (combinado) · 👍 (feito) ·
🎉 (conquista) · 🤔 (fiquei em dúvida) · 🙏 (agradecimento) · 😢 (deu ruim).
A linha do marcador é a ÚLTIMA e vem sozinha; nunca responda pergunta só com
reação; se nada específico aconteceu, não feche com reação.

### Mandar arquivo no chat
Você consegue ANEXAR arquivos do repositório na conversa. Escreva uma linha só:
ENVIAR: <caminho do arquivo>
(absoluto ou relativo à raiz). Uma linha por arquivo, depois do texto e antes do
REACT. Só arquivos de dentro do repositório, até 50 MB. Mande quando pedirem ou
quando acabou de gerar algo pra revisão. Diga em uma frase o que está indo.

### Mandar arquivo ou recado para OUTRA pessoa
Só quando quem fala PEDIR explicitamente ("manda o documento pro __PRINCIPAL_NAME__"):
ENVIAR PARA: <Nome> | <caminho do arquivo> | <uma linha de contexto, opcional>
RECADO PARA: <Nome> | <texto curto do recado>
O sistema mostra um resumo com botões Mandar / Cancelar — diga o que vai e pra
quem, e que é só confirmar no botão. Não diga que já foi entregue. Se o sistema
avisar que não achou a pessoa, acredite e explique.

### Motor vs. informação
- Você atua sobre a INFORMAÇÃO do projeto — nunca sobre a configuração do
  assistente. Pedido técnico ou de infra: "isso é com o __PRINCIPAL_NAME__".
- Perguntas ao interlocutor vão em TEXTO SIMPLES — não existe caixa de perguntas aqui.
- Você não fala em nome de ninguém publicamente nem manda nada pra fora do chat.
`

/** Resposta que é (ou começa com) uma chamada de ferramenta escrita como texto. */
function pareceFerramentaVazada(texto: string): boolean {
  return /^\s*(?:<[a-z_]+>\s*)?(Bash|Read|Edit|Write|Grep|Glob|MultiEdit|WebFetch|WebSearch|Task|TodoWrite|NotebookEdit)\s*\(\s*\{/.test(texto)
}

async function runAgentTurn(
  userText: string,
  speakerLine: string,
  cfg: Required<Pick<TelegramRepoBotConfig, "model" | "fallback_model" | "max_turns" | "sdk_inactivity_ms" | "sdk_hard_cap_ms" | "max_thinking_tokens">>,
  onProgress: (partial: string) => void,
  onTool?: (name: string) => void,
): Promise<string> {
  const history = conversationStore!.getHistory().filter(m => lastMessageAt === null || m.timestamp >= (lastMessageAt - IDLE_BOUNDARY_MS))
  let prompt = userText
  const recent = history.slice(-10)
  if (recent.length > 0) {
    const historyText = recent.map(m => `${m.role === "user" ? "Equipe" : "Assistente"}: ${m.content}`).join("\n")
    prompt = `Conversa anterior:\n${historyText}\n\nNova mensagem: ${userText}`
  }

  const timeoutController = new AbortController()
  const sdkOptions: Record<string, unknown> = {
    cwd: VAULT,
    abortController: timeoutController,
    model: cfg.model,
    fallbackModel: cfg.fallback_model,
    maxThinkingTokens: cfg.max_thinking_tokens,
    // SEM bypassPermissions (mudança SDK 0.3.x): sob bypass o canUseTool NUNCA
    // é consultado (CLAUDE_SDK_CAN_USE_TOOL_SHADOWED) — e aqui ele é o portão
    // de segurança (escrita só no vault, filtro de Bash). No modo default o
    // canUseTool é o handler de permissão headless: cada tool não auto-aprovada
    // passa por ele. Validar no primeiro tenant vivo neste template.
    tools: { type: "preset", preset: "claude_code" },
    // TRIM de contexto (portado 2026-07-20): sem catálogo de skills no prompt.
    skills: [],
    // AskUserQuestion é UI de terminal — no Telegram trava o turno esperando
    // resposta que nunca chega. Fora do tool set; o canUseTool abaixo é o
    // cinto-e-suspensório.
    disallowedTools: ["AskUserQuestion"],
    // SÓ "project": o CLAUDE.md do vault. Nunca "user".
    settingSources: ["project"],
    // Env minimizado — o subprocess não herda segredos além do necessário.
    env: {
      HOME,
      PATH: process.env.PATH ?? "",
      LANG: process.env.LANG ?? "C.UTF-8",
      TZ: process.env.TZ ?? "America/Sao_Paulo",
      CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? "",
      LIFEOS_NOTIFICATION_CHANNEL: "telegram",
    },
    maxTurns: cfg.max_turns,
    includePartialMessages: true,
    // Shape novo do SDK 0.3.x: { behavior, message } (era { result, reason } no 0.1.x).
    canUseTool: (toolName: string, input: unknown) => {
      const obj = (typeof input === "object" && input !== null) ? input as Record<string, unknown> : {}
      const pathOf = () => String(obj.file_path ?? obj.path ?? obj.notebook_path ?? "")
      const insideVault = (p: string) => p === "" || !p.startsWith("/") || p.startsWith(VAULT)

      if (toolName === "AskUserQuestion") {
        log("warn", "canUseTool blocked AskUserQuestion on Telegram", {})
        return { behavior: "deny", message: "AskUserQuestion não existe no Telegram (a chamada travaria o turno). Faça a pergunta em texto simples na sua resposta." }
      }
      const READONLY = new Set(["Read", "Grep", "Glob", "LS", "NotebookRead", "TodoWrite", "WebFetch", "WebSearch"])
      if (READONLY.has(toolName)) {
        const p = pathOf()
        if ((toolName === "Read" || toolName === "Grep" || toolName === "Glob" || toolName === "LS") && !insideVault(p) && !p.startsWith(MEDIA_TMP)) {
          return { behavior: "deny", message: "Este assistente só lê o repositório de __CLIENT_NAME__." }
        }
        return { behavior: "allow" }
      }
      if (toolName === "Bash") {
        const cmd = "command" in obj ? String(obj.command) : String(input)
        const proibido = /~\/\.claude|\/\.claude\/|\.env\b|\bcurl\b|\bwget\b|\bssh\b|\bsudo\b|\bsystemctl\b|printenv|\benv\b\s*$|\brm\s+-rf?\b|31337|\/notify/
        if (proibido.test(cmd)) {
          log("warn", "canUseTool: Bash bloqueado", { cmd: cmd.slice(0, 160) })
          return { behavior: "deny", message: "Comando fora do escopo do assistente." }
        }
        return { behavior: "allow" }
      }
      if (toolName === "Write" || toolName === "Edit" || toolName === "MultiEdit") {
        const p = pathOf()
        const abs = p.startsWith("/") ? p : join(VAULT, p)
        const dentroVault = abs.startsWith(VAULT + "/")
        const congelado = abs.includes("/docs/fontes/") || abs.includes("/inbox/raw/")
        if (dentroVault && !congelado) return { behavior: "allow" }
        return {
          behavior: "deny",
          message: congelado
            ? "docs/fontes/ e inbox/raw/ são imutáveis (acervo congelado / captura append-only)."
            : "Escrita só dentro do repositório de __CLIENT_NAME__.",
        }
      }
      return { behavior: "deny", message: `Ferramenta ${toolName} não habilitada neste assistente.` }
    },
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      // Identidade fatiada do falante concatenada por turno (só esta pessoa,
      // nunca o grafo inteiro) — controle de custo/turno, ver plano-bot-v2.
      append: `${SYSTEM_APPEND}\n\n### Quem está falando agora\n${speakerLine}\n`,
    },
  }
  if (lastSessionId) sdkOptions.resume = lastSessionId

  const conversation = query({ prompt, options: sdkOptions as any })
  let fullText = ""
  let streamBuf = ""
  // Watchdog de inatividade + hard cap (portado do bot vivo, 2026-07-20) no
  // lugar do teto de parede — turno legítimo longo não morre mais no timeout.
  let inactivityTimer: ReturnType<typeof setTimeout> | undefined
  const armInactivity = () => {
    if (inactivityTimer) clearTimeout(inactivityTimer)
    inactivityTimer = setTimeout(() => timeoutController.abort(), cfg.sdk_inactivity_ms)
  }
  armInactivity()
  const hardCapTimer = setTimeout(() => timeoutController.abort(), cfg.sdk_hard_cap_ms)
  try {
    for await (const message of conversation) {
      armInactivity()
      if (timeoutController.signal.aborted) break
      const msg = message as any
      if (msg.type === "system" && msg.subtype === "init" && msg.session_id) lastSessionId = msg.session_id
      // Streaming: deltas de texto do bloco em produção → progresso pro chat
      if (msg.type === "stream_event" && msg.event?.type === "content_block_delta" && msg.event.delta?.type === "text_delta") {
        streamBuf += String(msg.event.delta.text ?? "")
        onProgress(streamBuf)
      }
      if (msg.type === "stream_event" && msg.event?.type === "content_block_start") {
        streamBuf = "" // novo bloco de texto (ex.: depois de uma ferramenta) recomeça o buffer
        if (msg.event.content_block?.type === "tool_use") {
          onTool?.(String(msg.event.content_block.name ?? ""))
        }
      }
      if (msg.type === "assistant" && Array.isArray(msg.message?.content)) {
        for (const block of msg.message.content) {
          if (block.type === "text" && block.text) fullText = block.text
        }
      }
      if (msg.type === "result" && typeof msg.result === "string" && msg.result.trim()) {
        fullText = msg.result
      }
    }
  } finally {
    if (inactivityTimer) clearTimeout(inactivityTimer)
    clearTimeout(hardCapTimer)
  }

  if (timeoutController.signal.aborted && !fullText.trim()) {
    return streamBuf.trim() || "Essa levou mais tempo do que o meu limite por resposta. Manda de novo — se for pedido grande, quebra em partes menores."
  }
  if (!fullText.trim()) {
    return streamBuf.trim() || "Não consegui montar a resposta agora. Tenta de novo em instantes, por favor."
  }
  return fullText.trim()
}

// ── Envio (com streaming progressivo) ────────────────────────────────────────

function splitParts(text: string): string[] {
  const parts: string[] = []
  let rest = text
  while (rest.length > MAX_MSG_CHARS) {
    let cut = rest.lastIndexOf("\n", MAX_MSG_CHARS)
    if (cut < MAX_MSG_CHARS / 2) cut = MAX_MSG_CHARS
    parts.push(rest.slice(0, cut))
    rest = rest.slice(cut)
  }
  parts.push(rest)
  return parts
}

/**
 * Gerencia a mensagem "viva" durante o streaming: cria no primeiro trecho,
 * edita (throttled) conforme o texto cresce, e no final aplica a formatação
 * HTML definitiva (+ mensagens extras se passar do teto do Telegram).
 */
function makeStreamer(ctx: any) {
  let messageId: number | null = null
  let lastEdit = 0
  let lastSent = ""
  let inflight = false
  let isStatus = false        // a mensagem viva atual é linha de status (🔧), não texto real
  let lastStatusEdit = 0

  const push = async (partial: string, final = false) => {
    const now = Date.now()
    if (!final && (inflight || partial.length < STREAM_MIN_CHARS || now - lastEdit < STREAM_EDIT_MS)) return
    inflight = true
    try {
      const view = partial.length > MAX_MSG_CHARS ? partial.slice(0, MAX_MSG_CHARS - 2) + " …" : partial
      if (view === lastSent) return
      if (messageId === null) {
        const m = await ctx.reply(view)
        messageId = m.message_id
      } else {
        await ctx.api.editMessageText(ctx.chat.id, messageId, view).catch(() => {})
      }
      isStatus = false          // texto real assumiu a mensagem — status não sobrescreve mais
      lastSent = view
      lastEdit = now
    } catch { /* streaming é best-effort */ } finally {
      inflight = false
    }
  }

  // Linha de status de ferramenta (🔧): cria/edita a mensagem viva SÓ enquanto o
  // texto real da resposta não começou; o primeiro push() de texto a substitui.
  const status = async (label: string) => {
    const now = Date.now()
    if (inflight || (messageId !== null && !isStatus)) return
    if (label === lastSent || now - lastStatusEdit < STATUS_EDIT_MS) return
    inflight = true
    try {
      if (messageId === null) {
        const m = await ctx.reply(label)
        messageId = m.message_id
      } else {
        await ctx.api.editMessageText(ctx.chat.id, messageId, label).catch(() => {})
      }
      isStatus = true
      lastSent = label
      lastStatusEdit = now
    } catch { /* status é best-effort */ } finally {
      inflight = false
    }
  }

  const finish = async (text: string) => {
    // Espera push/status em voo assentar: se um ctx.reply do push ainda não
    // retornou, messageId está null e o finish mandaria uma SEGUNDA mensagem
    // com o mesmo texto (duplicata real observada no grupo, 15/09).
    for (let i = 0; i < 50 && inflight; i++) await new Promise(r => setTimeout(r, 100))
    const parts = splitParts(text)
    const first = parts[0]
    try {
      if (messageId !== null) {
        await ctx.api.editMessageText(ctx.chat.id, messageId, mdToTelegramHtml(first), { parse_mode: "HTML" })
          .catch(async () => { await ctx.api.editMessageText(ctx.chat.id, messageId, first).catch(() => {}) })
      } else {
        await ctx.reply(mdToTelegramHtml(first), { parse_mode: "HTML" }).catch(async () => { await ctx.reply(first) })
      }
      for (const part of parts.slice(1)) {
        await ctx.reply(mdToTelegramHtml(part), { parse_mode: "HTML" }).catch(async () => { await ctx.reply(part).catch(() => {}) })
      }
    } catch (err) {
      log("warn", "finish/send failed", { error: String(err).slice(0, 200) })
    }
  }

  return { push, status, finish }
}

// ── Comandos ─────────────────────────────────────────────────────────────────

/** Menu nativo do Telegram (botão "/"). Setado no boot via setMyCommands. */
const BOT_COMMANDS = [
  { command: "encaminhar", description: "Responda a um arquivo meu: /encaminhar Nome" },
  { command: "ajuda", description: "Como usar o assistente" },
]

const AJUDA_TEXT = [
  "👋 Sou o assistente de <b>__CLIENT_NAME__</b>.",
  "",
  "• Me manda texto ou áudio pra <b>conversar</b> ou perguntar sobre o que já está registrado.",
  "• Quando for algo que vale guardar (uma ideia, uma decisão, um dado), eu <b>guardo</b> — ou pergunto antes, se estiver em dúvida.",
  "• Foto e documento que você manda ficam guardados.",
  "",
  "<b>Mandar pra outra pessoa:</b>",
  "• Me peça \"manda o arquivo X pro __PRINCIPAL_NAME__\" — eu mostro um resumo e só mando depois que você tocar em <b>Mandar</b>.",
  "• /encaminhar Nome — respondendo a um arquivo que eu mandei, reenvia ele pra pessoa.",
].join("\n")

// ── Contexto de reply / encaminhamento ──────────────────────────────────────

/**
 * O Telegram manda o texto citado (reply_to_message / quote) e a origem de uma
 * mensagem encaminhada FORA do `text` — sem isto, "O texto da Maria é esse
 * @SolunarConversaBot" respondendo ao texto chega ao turno sem o texto (15/09).
 */
function messageContext(msg: any, botId: number): string {
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
    const autor = !replied ? "outra conversa" : doBot ? "você (o assistente)" : nome(replied.from) || "alguém"
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

// ── Boot ──────────────────────────────────────────────────────────────────────

export async function startTelegramRepoBot(config: TelegramRepoBotConfig): Promise<void> {
  if (!config.enabled) { log("info", "módulo desabilitado"); return }

  const token = process.env.TELEGRAM_BOT_TOKEN
  if (!token) { log("error", "TELEGRAM_BOT_TOKEN ausente no env"); return }
  if (!existsSync(VAULT)) { log("error", `vault não existe: ${VAULT}`); return }

  const allowed = new Set(
    (process.env.TELEGRAM_ALLOWED_USERS ?? "")
      .split(",").map(s => s.trim()).filter(Boolean).map(Number)
  )
  if (allowed.size === 0) { log("error", "nenhum chat_id autorizado (TELEGRAM_ALLOWED_USERS)"); return }

  const allowedGroups = new Set(
    (process.env.TELEGRAM_ALLOWED_GROUPS ?? "")
      .split(",").map(s => s.trim()).filter(Boolean).map(Number)
  )

  const cfg = {
    model: config.model ?? "claude-sonnet-5",
    fallback_model: config.fallback_model ?? "claude-opus-4-8",
    max_turns: config.max_turns ?? 15,
    sdk_inactivity_ms: config.sdk_inactivity_ms ?? 180_000,
    sdk_hard_cap_ms: config.sdk_hard_cap_ms ?? 900_000,
    max_thinking_tokens: config.max_thinking_tokens ?? 8000,
  }

  await mkdir(STATE_DIR, { recursive: true })
  await mkdir(LOGS_DIR, { recursive: true })
  conversationStore = new ConversationStore(join(STATE_DIR, "conversations.json"))
  await conversationStore.load()

  startedAt = Date.now()
  bot = new Bot(token)

  bot.use(async (ctx, next) => {
    const chat = ctx.chat
    // GRUPO: autorização é pelo grupo, não pela pessoa — quem o dono pôs no grupo
    // pode falar (inclui "Envio anônimo" de admin). Grupo desconhecido = silêncio
    // (loga o chat_id pra facilitar liberar via TELEGRAM_ALLOWED_GROUPS).
    if (chat && (chat.type === "group" || chat.type === "supergroup")) {
      if (allowedGroups.has(chat.id)) { await next(); return }
      log("warn", "mensagem em grupo não autorizado", { chatId: chat.id, title: chat.title })
      return
    }
    const userId = ctx.from?.id
    if (!userId || !allowed.has(userId)) {
      // Loga o id pra facilitar onboarding (ex.: primeiro "oi" da Ana)
      log("warn", "mensagem de usuário não autorizado", {
        userId, username: ctx.from?.username, name: [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(" "),
      })
      await ctx.reply("Este é o assistente de __CLIENT_NAME__ — acesso restrito. Peça liberação ao __PRINCIPAL_NAME__.").catch(() => {})
      return
    }
    await next()
  })

  // Fila por chat (fix 2026-09-15). O handler só FILTRA e ENFILEIRA — volta na
  // hora, então o loop do grammY nunca espera um turno. O dreno (abaixo) roda
  // destacado: um turno por vez por chat, e tudo que chegou junto vira um lote.
  bot.on("message", (ctx) => {
    messagesReceived++
    let text = ctx.message.text ?? ctx.message.caption ?? ""

    // GRUPO: só engaja quando chamado — menção ao @handle, o NOME de exibição
    // do bot como palavra (ex.: "Lia, ..."), reply a mensagem do bot, ou comando.
    // O resto da conversa do grupo não é da conta dele. (fix 23/11: só o @handle
    // exato acordava o bot; chamar pelo nome caía em silêncio, sem log.)
    const isGroup = ctx.chat.type === "group" || ctx.chat.type === "supergroup"
    if (isGroup) {
      const handleRe = new RegExp(`@${ctx.me.username}\\b`, "gi")
      const nome = (ctx.me.first_name ?? "").trim()
      const nomeRe = nome.length >= 3
        ? new RegExp(`(^|[^\\p{L}\\p{N}])${nome.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=$|[^\\p{L}\\p{N}])`, "iu")
        : null
      const mentioned = handleRe.test(text) || (nomeRe?.test(text) ?? false)
      const replyToBot = ctx.message.reply_to_message?.from?.id === ctx.me.id
      const isCommand = (ctx.message.text ?? "").startsWith("/")
      if (!mentioned && !replyToBot && !isCommand) return
      text = text.replace(handleRe, "").trim()
      log("info", "grupo: chamada recebida", {
        chatId: ctx.chat.id, via: replyToBot ? "reply" : isCommand ? "comando" : "menção",
      })
    }

    const chatId = ctx.chat.id
    const fila = pendingByChat.get(chatId) ?? []
    fila.push({ ctx, text, contexto: messageContext(ctx.message, ctx.me.id) })
    pendingByChat.set(chatId, fila)
    // Reação de CHEGADA pelo tipo do que veio (⚡ urgente · ✍ áudio · 👀 anexo ·
    // 🤔 pergunta · 🙏 agradecimento) — vale também pra mensagem que chega no meio
    // de um turno e vai pro próximo lote. A final, pelo que aconteceu no turno,
    // quem escolhe é o modelo (marcador REACT, ver runBatch).
    if (reactionsEnabled() && !(ctx.message.text ?? "").startsWith("/")) {
      ctx.react(receiptReaction(ctx.message, text) as any).catch(() => {})
    }

    if (processingByChat.get(chatId)) return // o dreno em curso pega no próximo lote
    const t = settleTimerByChat.get(chatId)
    if (t) clearTimeout(t)
    settleTimerByChat.set(chatId, setTimeout(() => {
      settleTimerByChat.delete(chatId)
      drainChat(chatId).catch(err => log("error", "dreno da fila crashou", { error: String(err).slice(0, 300) }))
    }, BATCH_SETTLE_MS))
  })

  /** Um lote por vez por chat, até a fila esvaziar. */
  async function drainChat(chatId: number): Promise<void> {
    if (processingByChat.get(chatId)) return
    processingByChat.set(chatId, true)
    let typingCtx: any = null
    const typing = setInterval(() => { typingCtx?.api.sendChatAction(chatId, "typing").catch(() => {}) }, 5000)
    try {
      let primeiroLote = true
      while ((pendingByChat.get(chatId)?.length ?? 0) > 0) {
        // O que chegou durante o turno anterior pode ser rajada ainda em curso.
        if (!primeiroLote) await new Promise(r => setTimeout(r, BATCH_SETTLE_MS))
        primeiroLote = false
        const lote = pendingByChat.get(chatId)!.splice(0)
        typingCtx = lote[lote.length - 1].ctx
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
    const ultimo = lote[lote.length - 1].ctx
    try {
      // Fronteira de sessão por inatividade
      if (lastMessageAt !== null && Date.now() - lastMessageAt > IDLE_BOUNDARY_MS) {
        lastSessionId = undefined
      }
      lastMessageAt = Date.now()

      const partes: string[] = []
      const quens = new Set<string>()
      const speakerLines = new Set<string>()
      for (const item of lote) {
        try {
          const prep = await prepareMessage(item)
          if (!prep) continue
          partes.push(`[de: ${prep.quem}]\n${sanitize(prep.text)}`)
          quens.add(prep.quem)
          speakerLines.add(prep.speakerLine)
        } catch (err) {
          log("error", "preparo de mensagem falhou", { error: String(err).slice(0, 300) })
          await item.ctx.reply("Não consegui ler essa mensagem direito — manda de novo?").catch(() => {})
        }
      }
      if (partes.length === 0) return
      if (partes.length > 1) log("info", "lote com várias mensagens num turno só", { chatId: ultimo.chat.id, n: partes.length })

      const userText = partes.length > 1
        ? `(${partes.length} mensagens chegaram em sequência — leia todas antes de responder e trate como uma conversa só.)\n\n${partes.join("\n\n")}`
        : partes[0]
      const quem = [...quens].join(", ")
      const streamer = makeStreamer(ultimo)
      const sessaoAntes = lastSessionId
      let reply = await runAgentTurn(
        userText,
        [...speakerLines].join("\n"),
        cfg,
        (partial) => { if (!pareceFerramentaVazada(partial)) void streamer.push(partial) },
        (name) => { void streamer.status(toolStatusLabel(name)) },
      )
      // Guarda contra "ferramenta escrita como texto": às vezes o modelo
      // escreve `Bash({...})` na resposta em vez de CHAMAR a ferramenta e
      // encerra o turno — o comando vaza pro chat e nada é feito (23/09).
      // Refaz o turno uma vez, a partir da sessão de antes (sem o texto
      // ruim no contexto), com um aviso explícito. Se repetir, erro limpo.
      if (pareceFerramentaVazada(reply)) {
        log("warn", "resposta com chamada de ferramenta em texto — refazendo turno", { trecho: reply.slice(0, 160) })
        lastSessionId = sessaoAntes
        // 2ª tentativa no modelo de reserva (Opus): só gasta cota maior
        // quando o principal já falhou neste turno.
        reply = await runAgentTurn(
          `${userText}\n\n(Aviso do sistema: na tentativa anterior você ESCREVEU uma chamada de ferramenta como texto, ex. "Bash({...})", em vez de executá-la. Use as ferramentas de verdade e responda à pessoa só com o resultado, em português.)`,
          [...speakerLines].join("\n"),
          { ...cfg, model: cfg.fallback_model, fallback_model: cfg.model },
          (partial) => { if (!pareceFerramentaVazada(partial)) void streamer.push(partial) },
          (name) => { void streamer.status(toolStatusLabel(name)) },
        )
        if (pareceFerramentaVazada(reply)) {
          log("error", "chamada de ferramenta em texto de novo — desistindo do turno", { trecho: reply.slice(0, 160) })
          reply = "Tropecei aqui do meu lado e não consegui concluir. Pode mandar de novo? Se repetir, o __PRINCIPAL_NAME__ vai olhar."
        }
      }
      // Reação FINAL: o modelo pode fechar com REACT:<emoji> numa linha própria;
      // o sistema troca a reação de chegada pela que reflete o que aconteceu e
      // NUNCA deixa o marcador vazar como texto (mesmo com reações desligadas).
      // Anexos de saída (portado do tenant-c, 25/09): linhas `ENVIAR: <caminho>`
      // saem do texto e viram sendDocument depois da resposta. Tirar ANTES do
      // REACT, que precisa ser a última linha pra casar.
      // Voz sob pedido (16/11): bloco <falar>…</falar> sai do texto e vira bolha
      // de voz. Tirar PRIMEIRO — o bloco pode ter várias linhas.
      const { texto: semFala, falar } = splitSpeakBlocks(reply)
      reply = semFala
      // Envio pra OUTRA pessoa (21/11): `ENVIAR PARA:` / `RECADO PARA:` saem
      // antes do `ENVIAR:` (que não casa com eles, mas a ordem deixa explícito).
      const { texto: semEnvios, pedidos: enviosPedidos, malformados: enviosMal } = fwd.splitForwardMarkers(reply)
      reply = semEnvios
      const { texto: semAnexos, paths: anexosPedidos } = splitSendMarkers(reply)
      const { texto, emoji } = splitReactMarker(semAnexos)
      // Resposta que veio SÓ com o marcador (sem texto): manda o emoji como
      // bolha curta em vez de deixar "REACT:..." vazar cru — e sem bolha vazia.
      const respostaFinal = texto.trim() || (falar ? "🔊" : "") || emoji || (anexosPedidos.length > 0 ? "📎" : "") || (enviosPedidos.length > 0 ? "📤" : reply)
      if (emoji && reactionsEnabled()) {
        ultimo.api.setMessageReaction(ultimo.chat.id, ultimo.message.message_id, [{ type: "emoji", emoji }])
          .catch(() => {})
      }
      await streamer.finish(respostaFinal)
      // Voz sob pedido: depois do texto, antes dos anexos. Falha vira aviso no chat.
      let audioEnviado = false
      if (falar) {
        if (spokenVoiceEnabled()) {
          try {
            await sendSpokenText(ultimo.api, ultimo.chat.id, ultimo.message.message_id, falar, log)
            audioEnviado = true
          } catch (err) {
            log("warn", "voz sob pedido falhou", { error: String(err).slice(0, 300) })
            await ultimo.reply("Não consegui gravar o áudio agora — o conteúdo está no texto acima.").catch(() => {})
          }
        } else {
          log("warn", "bloco <falar> com voz desligada no env", {})
        }
      }
      // Resumo automático por mensagem: só com VOICE_AUTO=1 (desligado por padrão).
      if (!falar && texto.trim() && voiceEnabled(ultimo.chat.type)) {
        sendVoiceSummary(ultimo.api, ultimo.chat.id, ultimo.message.message_id, texto, log)
      }
      // Anexos pedidos pelo modelo, na ordem, depois do texto, respondendo à
      // mensagem de quem pediu (em grupo fica claro pra quem é). Falha de um não
      // derruba os outros; o motivo vai pro chat em vez de sumir calado.
      const anexosEnviados: string[] = []
      for (const raw of anexosPedidos) {
        try {
          const anexo = await resolveAttachment(raw, VAULT)
          await ultimo.api.sendChatAction(ultimo.chat.id, "upload_document").catch(() => {})
          await ultimo.api.sendDocument(ultimo.chat.id, new InputFile(anexo.path, anexo.name), {
            reply_parameters: { message_id: ultimo.message.message_id, allow_sending_without_reply: true },
          })
          anexosEnviados.push(anexo.name)
          log("info", "Document sent", { file: anexo.path, size: anexo.size })
        } catch (err) {
          const motivo = err instanceof Error ? err.message : String(err)
          log("warn", "Document send failed", { requested: raw, error: motivo })
          await ultimo.reply(`Não consegui mandar o arquivo ${raw.split("/").pop()}: ${motivo}.`).catch(() => {})
        }
      }
      // Envios pra outra pessoa: resolve nome + arquivo e mostra a confirmação
      // (Mandar / Cancelar) pra quem pediu. Nada sai antes do clique.
      const enviosPropostos: string[] = []
      if (enviosMal.length > 0) {
        log("warn", "marcador de envio pra outra pessoa malformado", { n: enviosMal.length })
        await ultimo.reply("Tentei preparar um envio pra outra pessoa mas o pedido saiu incompleto — não mandei nada. Pode pedir de novo?").catch(() => {})
      }
      for (const pedido of enviosPedidos) {
        const r = await proporEnvio(ultimo, pedido)
        enviosPropostos.push(r)
      }
      // Histórico registra o que foi anexado — no próximo turno o modelo sabe
      // que o arquivo já chegou.
      let registro = anexosEnviados.length > 0
        ? `${respostaFinal}\n\n[anexos enviados: ${anexosEnviados.join(", ")}]`
        : respostaFinal
      if (enviosPropostos.length > 0) registro += `\n\n[envios pra outra pessoa: ${enviosPropostos.join("; ")}]`
      // O histórico guarda que houve áudio e o que foi dito — senão no próximo
      // turno ele "esquece" que falou e volta a dizer que não gera áudio.
      if (audioEnviado && falar) registro += `\n\n[áudio enviado (sua voz), dizendo: ${falar.slice(0, 1200)}]`
      await conversationStore!.addExchange(userText.slice(0, 2000), registro.slice(0, 2000))
      // Rastro auditável: se o turno alterou algo na knowledge-base, o commit
      // registra QUEM originou a mudança (nada staged → commit no-op). A captura
      // já carrega a autoria no frontmatter (`de:`); isto cobre as edições do SDK.
      // Trailers de origem: o deploy automático do site (VPS) lê isto quando a
      // publicação falha e responde a mensagem original de quem pediu, no
      // mesmo chat, com o motivo. Sem isso a pessoa ouve "entra no ar em
      // alguns minutos" e nunca sabe que barrou (23/09, card {CCC}).
      gitCommitPush(
        `[bot/edicao] alteração via conversa — por ${quem}\n\n` +
        `Bot-Chat: ${ultimo.chat.id}\nBot-Msg: ${ultimo.message.message_id}`,
      )
      messagesResponded++
    } catch (err) {
      log("error", "handler error", { error: String(err).slice(0, 300) })
      if (/maximum number of turns/i.test(String(err))) {
        await ultimo.reply(`Essa tarefa passou do limite de ${cfg.max_turns} passos numa mensagem só e eu parei no meio. Manda "continua" que eu retomo de onde parei.`).catch(() => {})
        return
      }
      await ultimo.reply("Deu um erro inesperado aqui do meu lado. Tenta de novo — se repetir, avisa o operador.").catch(() => {})
    }
  }

  // ── Envio pra outra pessoa (ENVIAR PARA / RECADO PARA / /encaminhar) ──────

  /** Nome de quem está pedindo, pelo roster (fallback: nome do Telegram). */
  function nomeDeQuemPede(ctx: any): string {
    const fb = [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(" ") || "Alguém da equipe"
    return resolveSpeaker(ctx.from.id, fb, VAULT).nome
  }

  /** Mostra a confirmação com botões. Devolve uma linha pro histórico. */
  async function mostrarConfirmacao(ctx: any, p: Omit<fwd.EnvioPendente, "id" | "criadoEm" | "origemChatId" | "origemMsgId">): Promise<void> {
    const pend = fwd.guardaPendente({ ...p, origemChatId: ctx.chat.id, origemMsgId: ctx.message.message_id })
    const kb = new InlineKeyboard().text("📤 Mandar", `f:ok:${pend.id}`).text("Cancelar", `f:no:${pend.id}`)
    await ctx.reply(fwd.textoConfirmacao(pend), {
      reply_markup: kb,
      reply_parameters: { message_id: ctx.message.message_id, allow_sending_without_reply: true },
    })
    await fwd.logEnvio(ENVIOS_LOG, pend, "proposto")
  }

  /** Resolve um pedido do modelo e mostra a confirmação (ou o motivo de não dar). */
  async function proporEnvio(ctx: any, pedido: fwd.PedidoEnvio): Promise<string> {
    const r = fwd.resolveDestinatario(pedido.nome, VAULT, allowed)
    if (!r.ok) {
      const msg = r.motivo === "ambiguo"
        ? `"${pedido.nome}" bate com mais de uma pessoa (${r.candidatos.join(", ")}). Não mandei nada — me diz qual.`
        : `Não achei "${pedido.nome}" entre as pessoas que falam comigo. Não mandei nada.`
      log("warn", "envio pra outra pessoa: destinatário não resolvido", { pedido: pedido.nome, motivo: r.motivo })
      await ctx.reply(msg).catch(() => {})
      return `${pedido.nome}: ${r.motivo === "ambiguo" ? "nome ambíguo, não enviado" : "pessoa não encontrada, não enviado"}`
    }
    const solicitanteNome = nomeDeQuemPede(ctx)
    const base = {
      solicitanteId: ctx.from.id, solicitanteNome,
      destinatarioId: r.chatId, destinatarioNome: r.nome, contexto: pedido.contexto,
    }
    if (pedido.tipo === "recado") {
      if (pedido.conteudo.length > fwd.MAX_RECADO_CHARS) {
        await ctx.reply(`O recado pra ${r.nome} ficou longo demais pra recado. Não mandei — dá pra virar um documento e eu mando o arquivo.`).catch(() => {})
        return `${r.nome}: recado longo demais, não enviado`
      }
      await mostrarConfirmacao(ctx, { ...base, tipo: "recado", conteudo: pedido.conteudo, rotulo: "recado", caminhoLog: "" })
      return `recado pra ${r.nome} aguardando confirmação de ${solicitanteNome}`
    }
    try {
      const a = await fwd.resolveArquivoParaOutro(pedido.conteudo, VAULT)
      await mostrarConfirmacao(ctx, { ...base, tipo: "arquivo", conteudo: a.path, rotulo: a.name, caminhoLog: a.rel })
      return `${a.name} pra ${r.nome} aguardando confirmação de ${solicitanteNome}`
    } catch (err) {
      const motivo = err instanceof Error ? err.message : String(err)
      log("warn", "envio pra outra pessoa: arquivo recusado", { requested: pedido.conteudo, error: motivo })
      await ctx.reply(`Não dá pra mandar ${pedido.conteudo.split("/").pop()} pra ${r.nome}: ${motivo}.`).catch(() => {})
      return `${pedido.conteudo} pra ${r.nome}: recusado (${motivo})`
    }
  }

  /** /encaminhar <Nome>, em resposta a uma mensagem do bot com anexo. Sem modelo. */
  async function handleEncaminhar(ctx: any, args: string): Promise<void> {
    const orig = ctx.message.reply_to_message
    if (!args) { await ctx.reply("Use assim: responda a uma mensagem minha que tenha arquivo e escreva /encaminhar <Nome>.").catch(() => {}); return }
    if (!orig || orig.from?.id !== ctx.me.id) {
      await ctx.reply("Pra encaminhar, responda a uma mensagem MINHA que tenha um arquivo e escreva /encaminhar <Nome>.").catch(() => {}); return
    }
    const foto = Array.isArray(orig.photo) ? orig.photo[orig.photo.length - 1] : null
    const doc = orig.document
    if (!doc && !foto) { await ctx.reply("Essa mensagem não tem arquivo pra encaminhar.").catch(() => {}); return }
    const r = fwd.resolveDestinatario(args, VAULT, allowed)
    if (!r.ok) {
      await ctx.reply(r.motivo === "ambiguo"
        ? `"${args}" bate com mais de uma pessoa (${r.candidatos.join(", ")}). Escreve o nome de quem você quer.`
        : `Não achei "${args}" entre as pessoas que falam comigo.`).catch(() => {})
      return
    }
    const rotulo = doc ? String(doc.file_name ?? "arquivo") : "uma foto"
    await mostrarConfirmacao(ctx, {
      solicitanteId: ctx.from.id, solicitanteNome: nomeDeQuemPede(ctx),
      destinatarioId: r.chatId, destinatarioNome: r.nome, contexto: "",
      tipo: "encaminhado", conteudo: doc ? `doc:${doc.file_id}` : `photo:${foto.file_id}`,
      rotulo, caminhoLog: rotulo,
    })
  }

  /** Clique em Mandar / Cancelar. */
  async function handleEnvioCallback(ctx: any, acao: "ok" | "no", id: string): Promise<void> {
    const p = fwd.pegaPendente(id)
    const msg = ctx.callbackQuery.message
    const fecha = (texto: string) => msg
      ? ctx.api.editMessageText(msg.chat.id, msg.message_id, texto, { reply_markup: { inline_keyboard: [] } }).catch(() => {})
      : Promise.resolve()
    if (!p) {
      await ctx.answerCallbackQuery({ text: "Esse pedido expirou. Pede de novo." }).catch(() => {})
      await fecha("⌛ Pedido expirado — nada foi enviado.")
      return
    }
    if (ctx.from?.id !== p.solicitanteId) {
      await ctx.answerCallbackQuery({ text: `Só ${p.solicitanteNome} pode confirmar esse envio.` }).catch(() => {})
      return
    }
    fwd.removePendente(id) // um clique só
    const o = p.tipo === "recado" ? "o recado" : p.rotulo
    if (acao === "no") {
      await ctx.answerCallbackQuery({ text: "Cancelado." }).catch(() => {})
      await fecha(`✖️ Cancelado — não mandei ${o} para ${p.destinatarioNome}.`)
      await fwd.logEnvio(ENVIOS_LOG, p, "cancelado")
      return
    }
    await ctx.answerCallbackQuery({ text: "Mandando…" }).catch(() => {})
    const cab = fwd.cabecalhoRecebedor(p)
    try {
      if (p.tipo === "recado") {
        await ctx.api.sendMessage(p.destinatarioId, cab)
      } else if (p.tipo === "arquivo") {
        // revalida na hora do envio (o arquivo pode ter mudado desde a proposta)
        const a = await fwd.resolveArquivoParaOutro(p.conteudo, VAULT)
        await ctx.api.sendChatAction(p.destinatarioId, "upload_document").catch(() => {})
        await ctx.api.sendDocument(p.destinatarioId, new InputFile(a.path, a.name), { caption: cab.slice(0, 1024) })
      } else {
        const [kind, fileId] = [p.conteudo.slice(0, p.conteudo.indexOf(":")), p.conteudo.slice(p.conteudo.indexOf(":") + 1)]
        if (kind === "photo") await ctx.api.sendPhoto(p.destinatarioId, fileId, { caption: cab.slice(0, 1024) })
        else await ctx.api.sendDocument(p.destinatarioId, fileId, { caption: cab.slice(0, 1024) })
      }
      await fecha(`✅ Mandei ${o} para ${p.destinatarioNome}.`)
      await fwd.logEnvio(ENVIOS_LOG, p, "enviado")
      log("info", "envio pra outra pessoa entregue", { tipo: p.tipo })
    } catch (err) {
      const semConversa = fwd.erroSemConversa(err)
      const motivo = semConversa
        ? `${p.destinatarioNome} ainda não abriu conversa comigo no privado (ou me bloqueou), e o Telegram não deixa eu puxar a conversa. Peça pra mandar um "oi" pra mim (@__BOT_HANDLE__) e tente de novo.`
        : (err instanceof Error ? err.message : String(err))
      await fecha(`⚠️ Não consegui mandar ${o} para ${p.destinatarioNome}: ${motivo}`)
      await fwd.logEnvio(ENVIOS_LOG, p, semConversa ? "falhou-sem-conversa" : "falhou", String((err as any)?.description ?? err))
      log("warn", "envio pra outra pessoa falhou", { tipo: p.tipo, semConversa, error: String((err as any)?.description ?? err).slice(0, 200) })
    }
  }

  /**
   * Preparo de UMA mensagem: comando, áudio, anexo. Retorna o texto
   * pro turno, ou null se a mensagem já foi resolvida aqui (respondeu e encerrou).
   */
  async function prepareMessage(item: PendingMsg): Promise<{ text: string; quem: string; speakerLine: string } | null> {
    const ctx = item.ctx
    const msgId = ctx.message.message_id
    let text = item.text

    // "Envio anônimo" (admin anônimo do grupo) chega como GroupAnonymousBot.
    const ANON_ADMIN_ID = 1087968824
    const fallbackNome = ctx.from.id === ANON_ADMIN_ID
      ? "Admin do grupo (envio anônimo)"
      : [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(" ") || String(ctx.from.id)
    // Resolve quem fala (roster + grafo do vault) — nome canônico + papéis/círculos.
    const speaker = resolveSpeaker(ctx.from.id, fallbackNome, VAULT)
    const quem = speaker.nome
    const speakerLine = speakerContextLine(speaker)

    // Comandos determinísticos (sem LLM) — interceptam ANTES do turno.
    const rawText = ctx.message.text ?? ""
    const cmd0 = rawText.trim().split(/\s+/)[0].split("@")[0]
    if (cmd0 === "/ajuda" || cmd0 === "/start") {
      await ctx.reply(AJUDA_TEXT, { parse_mode: "HTML" }).catch(() => {})
      return null
    }
    if (cmd0 === "/encaminhar") {
      await handleEncaminhar(ctx, rawText.trim().slice(rawText.trim().split(/\s+/)[0].length).trim())
      return null
    }

    // ÁUDIO → transcreve (Groq); a transcrição vira a mensagem
    const voice = ctx.message.voice ?? ctx.message.audio
    if (voice) {
      const durationSec = Number(voice.duration ?? 0)
      await mkdir(MEDIA_TMP, { recursive: true })
      const audioPath = `${MEDIA_TMP}/${msgId}.ogg`
      const okDl = await downloadFile(token!, voice.file_id, audioPath)
      if (!okDl) { await ctx.reply("Não consegui baixar esse áudio — manda de novo?"); return null }
      let transcript = ""
      try {
        transcript = await transcribeGroq(audioPath, `${msgId}.ogg`)
      } catch (err) {
        log("warn", "transcrição falhou", { error: String(err).slice(0, 200) })
        await ctx.reply("Não consegui transcrever o áudio agora. Tenta de novo, ou manda por texto.")
        return null
      }
      if (durationSec > LONG_AUDIO_SEC) {
        // Áudio longo é material por natureza → arquiva. Áudio curto vira texto pro turno decidir.
        await saveRaw(msgId, "audio", transcript, `de: "${quem}"\nduracao_seg: ${durationSec}\n`)
        await ctx.reply(`Áudio longo (${Math.round(durationSec / 60)}min) recebido e transcrito — guardei aqui pra gente ver com calma. O que precisar de resposta na hora, manda em áudio curto ou texto.`)
        return null
      }
      text = text ? `${text}\n\n[transcrição do áudio]: ${transcript}` : transcript
    }

    // FOTO/DOCUMENTO → salva no repo junto da captura
    const photo = Array.isArray(ctx.message.photo) ? ctx.message.photo[ctx.message.photo.length - 1] : null
    const doc = ctx.message.document
    if (photo || doc) {
      const { dia, hora } = tsParts()
      const fname = doc?.file_name ?? `${hora}-${msgId}.jpg`
      const relDir = `inbox/raw/${dia}/files`
      await mkdir(join(VAULT, relDir), { recursive: true })
      const rel = `${relDir}/${msgId}-${fname}`
      const okDl = await downloadFile(token!, (photo ?? doc)!.file_id, join(VAULT, rel))
      if (okDl) {
        // Anexo (foto/documento) é material explícito → sempre salvo na inbox.
        await saveRaw(msgId, photo ? "foto" : "documento", text || "(sem legenda)", `de: "${quem}"\narquivo: ${rel}\n`)
        text = `[${quem} enviou ${photo ? "uma foto" : `o arquivo ${fname}`}, salvo em ${rel} — use Read se precisar ver]\n${text || ""}`
      }
    }
    // TEXTO e ÁUDIO CURTO não são mais capturados automaticamente — o turno
    // conversa e decide salvar de propósito o que for material (ver SYSTEM_APPEND).

    if (!text.trim()) { await ctx.reply("Recebi o anexo — guardei aqui. Se quiser, me conta o que é pra eu registrar direito."); return null }

    // Reply/encaminhamento entra DEPOIS do teste acima: anexo encaminhado sem
    // legenda continua caindo no "Recebi o anexo", não vira turno sozinho.
    if (item.contexto) text = `${item.contexto}\n${text}`
    return { text, quem, speakerLine }
  }

  // Callbacks inline (confirmação de envio pra outra pessoa).
  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data
    const chatId = ctx.from?.id
    const messageId = ctx.callbackQuery.message?.message_id
    const mf = /^f:(ok|no):([a-z0-9]+)$/.exec(data)
    if (mf) {
      try { await handleEnvioCallback(ctx, mf[1] as "ok" | "no", mf[2]) }
      catch (err) { log("error", "callback de envio falhou", { error: String(err).slice(0, 300) }) }
      await ctx.answerCallbackQuery().catch(() => {})
      return
    }
    await ctx.answerCallbackQuery().catch(() => {}) // para o spinner do botão
  })

  bot.catch((err) => log("error", "grammy error", { error: String(err).slice(0, 300) }))

  // Menu nativo do Telegram (botão "/"). Idempotente — reaplicado a cada boot.
  await bot.api.setMyCommands(BOT_COMMANDS).catch((err) =>
    log("warn", "setMyCommands falhou", { error: String(err).slice(0, 200) }))
  log("info", "iniciando bot de __CLIENT_NAME__", { vault: VAULT, allowed: [...allowed], model: cfg.model })
  await bot.start({ onStart: (info) => log("info", `bot @${info.username} online`) })
}
