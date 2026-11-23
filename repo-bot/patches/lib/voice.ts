/**
 * voice.ts — voz de saída do tenant-d (2026-11-16)
 *
 * Espelho do sendVoiceSummary do Jão (PULSE/modules/telegram.ts), adaptado ao
 * container (sem Inference.ts): depois que a resposta em texto já saiu, um
 * resumo curto (Haiku via SDK, mesma assinatura OAuth) vira bolha de voz
 * ElevenLabs respondendo a mesma mensagem. Fire-and-forget — falha de TTS
 * nunca segura o turno nem a fila do chat.
 *
 * Dois modos (16/11, Marquito: "não quero áudio a cada mensagem, quero resumo longo"):
 *   - SOB PEDIDO (padrão): o modelo escreve o texto a ser falado entre
 *     <falar>…</falar>; o bloco sai do chat e vira UMA bolha de voz, sem resumir.
 *   - AUTOMÁTICO (VOICE_AUTO=1): resumo curto de toda resposta no privado.
 *
 * Precisa no env:
 *   ELEVENLABS_API_KEY     conta ElevenLabs (TTS)
 *   BOT_VOICE_ID      voz do bot
 * Interruptores:
 *   VOICE_ENABLED=0        desliga tudo
 *   VOICE_AUTO=1           liga o resumo automático por mensagem (default: desligado)
 *   VOICE_IN_GROUPS=1      resumo automático também em grupo
 */

import { InputFile } from "grammy"
import { query } from "@anthropic-ai/claude-agent-sdk"

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY ?? ""
const VOICE_ID = process.env.BOT_VOICE_ID ?? ""
const SUMMARY_MODEL = process.env.VOICE_SUMMARY_MODEL ?? "claude-haiku-4-5-20251001"

const SHORT_REPLY_WORDS = 8          // resposta curta: o texto já basta
const MAX_SUMMARY_WORDS = 40
const MIN_FALLBACK_WORDS = 6         // fallback de 2 palavras contra resposta longa = bolha inútil
const MEANINGFUL_REPLY_WORDS = 25
const SUMMARY_BUDGET_MS = 25_000

type Log = (level: string, msg: string, extra?: Record<string, unknown>) => void

const MAX_SPOKEN_CHARS = 5000        // ~5 min de fala; teto de custo por bolha

function voiceConfigured(): boolean {
  return !!ELEVENLABS_API_KEY && !!VOICE_ID && process.env.VOICE_ENABLED !== "0"
}

/** Voz sob pedido (bloco <falar>) — vale no privado e em grupo, porque alguém pediu. */
export function spokenVoiceEnabled(): boolean {
  return voiceConfigured()
}

const FALAR_BLOCK = /<falar>([\s\S]*?)<\/falar>/gi

/** Tira os blocos <falar>…</falar> da resposta. O texto falado sai do chat. */
export function splitSpeakBlocks(reply: string): { texto: string; falar: string | null } {
  const partes: string[] = []
  const texto = reply.replace(FALAR_BLOCK, (_, corpo: string) => { partes.push(corpo.trim()); return "" })
  const falar = partes.filter(Boolean).join("\n\n")
  return { texto: texto.replace(/\n{3,}/g, "\n\n").trim(), falar: falar || null }
}

/** Resumo automático por mensagem — só com VOICE_AUTO=1. */
export function voiceEnabled(chatType: string | undefined): boolean {
  if (!voiceConfigured() || process.env.VOICE_AUTO !== "1") return false
  if (chatType && chatType !== "private" && process.env.VOICE_IN_GROUPS !== "1") return false
  return true
}

function tidy(raw: string): string {
  let s = raw.trim()
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/^(assistente|resumo|summary|voz)[:\-—]\s*/i, "")
    .replace(/[*_#`>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
  const words = s.split(/\s+/)
  if (words.length > MAX_SUMMARY_WORDS) s = words.slice(0, MAX_SUMMARY_WORDS).join(" ").replace(/[,;:\s]+$/, "") + "…"
  return s
}

function fallbackFirstSentence(text: string): string {
  const limpo = text.replace(/<[^>]+>/g, " ")
  const m = limpo.match(/^[\s\S]*?[.!?](?=\s|$)/)
  return tidy(m ? m[0] : limpo.split(/\s+/).slice(0, 30).join(" "))
}

const SUMMARY_SYSTEM = [
  "Você é o assistente de __CLIENT_NAME__.",
  "Tarefa: escrever um resumo FALADO, curto, de uma resposta em texto que acabou de ser enviada no Telegram.",
  "SEMPRE em português do Brasil.",
  "Uma ou duas frases declarativas, no máximo 35 palavras.",
  "Comece pelo que importa. Sem preâmbulo, sem 'então basicamente', sem repetir a pergunta.",
  "Texto corrido para ser lido em voz alta: sem markdown, sem emoji, sem listas, sem links, sem rótulos, sem aspas.",
  "Fale em primeira pessoa, com calma e calor, sem exagero.",
  "Escreva só o resumo, nada mais.",
].join("\n")

async function summarize(replyText: string, log: Log): Promise<{ summary: string; source: "inference" | "fallback" }> {
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), SUMMARY_BUDGET_MS)
  try {
    let out = ""
    for await (const msg of query({
      prompt: replyText.slice(0, 8000),
      options: {
        model: SUMMARY_MODEL,
        abortController: abort,
        maxTurns: 1,
        thinking: { type: "disabled" },  // resumo de 1–2 frases não precisa pensar; com thinking passava de 25s
        tools: [],
        skills: [],
        settingSources: [],
        systemPrompt: SUMMARY_SYSTEM,
        env: {
          HOME: process.env.HOME ?? "",
          PATH: process.env.PATH ?? "",
          LANG: process.env.LANG ?? "C.UTF-8",
          CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? "",
        },
      } as any,
    })) {
      const m = msg as any
      if (m.type === "result" && typeof m.result === "string") out = m.result
    }
    if (!out.trim()) throw new Error("resumo vazio")
    return { summary: tidy(out), source: "inference" }
  } catch (err) {
    log("warn", "voz: resumo falhou, usando primeira frase", { error: String(err).slice(0, 200) })
    return { summary: fallbackFirstSentence(replyText), source: "fallback" }
  } finally {
    clearTimeout(timer)
  }
}

async function synthesize(text: string): Promise<Buffer> {
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}?output_format=opus_48000_64`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "xi-api-key": ELEVENLABS_API_KEY, "Accept": "audio/ogg" },
    body: JSON.stringify({
      text,
      model_id: "eleven_turbo_v2_5",
      // Sem language_code o turbo adivinha o idioma por request e erra em frase curta.
      language_code: "pt",
      // Menos estabilidade + algum estilo = mais personagem (16/11, troca River → Glinda).
      voice_settings: { stability: 0.35, similarity_boost: 0.75, style: 0.4, speed: 1.0, use_speaker_boost: true },
    }),
  })
  if (!res.ok) throw new Error(`ElevenLabs ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`)
  return Buffer.from(await res.arrayBuffer())
}

/** Duração pelo granulepos da última página OggS (48kHz fixo) — sem isso o Telegram Web mostra 0:00. */
function oggOpusDurationSec(buf: Buffer): number | undefined {
  for (let i = buf.length - 27; i >= 0; i--) {
    if (buf[i] === 0x4f && buf[i + 1] === 0x67 && buf[i + 2] === 0x67 && buf[i + 3] === 0x53) {
      const granule = buf.readBigUInt64LE(i + 6)
      return granule > 0n ? Math.round(Number(granule) / 48000) : undefined
    }
  }
  return undefined
}

/**
 * Bolha de voz com o resumo da resposta, respondendo a `replyTo`. Nunca dar
 * await nisso no handler: é fire-and-forget por construção.
 */
export function sendVoiceSummary(
  api: { sendVoice: (chatId: number, voice: InputFile, other?: Record<string, unknown>) => Promise<unknown> },
  chatId: number,
  replyTo: number,
  fullText: string,
  log: Log,
): void {
  const wordCount = fullText.trim().split(/\s+/).length
  if (wordCount < SHORT_REPLY_WORDS) return

  void (async () => {
    const t0 = Date.now()
    try {
      const { summary, source } = await summarize(fullText, log)
      const summaryWords = summary ? summary.split(/\s+/).length : 0
      if (!summary || (source === "fallback" && summaryWords < MIN_FALLBACK_WORDS && wordCount >= MEANINGFUL_REPLY_WORDS)) {
        log("info", "voz: pulada — resumo vazio/inútil", { chatId, source, summaryWords, wordCount })
        return
      }
      const buf = await synthesize(summary)
      await api.sendVoice(chatId, new InputFile(buf, "assistente.ogg"), {
        duration: oggOpusDurationSec(buf),
        reply_parameters: { message_id: replyTo, allow_sending_without_reply: true },
      })
      log("info", "voz enviada", { chatId, source, summaryWords, ms: Date.now() - t0 })
    } catch (err) {
      log("warn", "voz: pipeline falhou", { chatId, error: String(err).slice(0, 300) })
    }
  })()
}

/**
 * Fala `text` inteiro (sem resumir) como UMA bolha respondendo a `replyTo`.
 * Await-ável: o chamador decide; falha volta como erro pra virar aviso no chat.
 */
export async function sendSpokenText(
  api: { sendVoice: (chatId: number, voice: InputFile, other?: Record<string, unknown>) => Promise<unknown>; sendChatAction?: (chatId: number, action: string) => Promise<unknown> },
  chatId: number,
  replyTo: number,
  text: string,
  log: Log,
): Promise<void> {
  let falado = text.replace(/<[^>]+>/g, " ").replace(/[*_#`>]/g, "").replace(/\s+/g, " ").trim()
  if (falado.length > MAX_SPOKEN_CHARS) {
    log("warn", "voz: texto falado acima do teto, cortando", { chars: falado.length })
    const corte = falado.slice(0, MAX_SPOKEN_CHARS)
    falado = corte.slice(0, Math.max(corte.lastIndexOf(". ") + 1, MAX_SPOKEN_CHARS * 0.8))
  }
  const t0 = Date.now()
  await api.sendChatAction?.(chatId, "record_voice").catch(() => {})
  const buf = await synthesize(falado)
  await api.sendVoice(chatId, new InputFile(buf, "assistente.ogg"), {
    duration: oggOpusDurationSec(buf),
    reply_parameters: { message_id: replyTo, allow_sending_without_reply: true },
  })
  log("info", "voz sob pedido enviada", { chatId, chars: falado.length, ms: Date.now() - t0 })
}
