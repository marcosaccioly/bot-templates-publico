/**
 * reactions.ts — reações do tenant-d (2026-09-15)
 *
 * Duas fases, mesma ideia do bot do Marquito:
 *   1. CHEGADA — reação determinística pelo TIPO do que veio (⚡ urgente, ✍ áudio,
 *      👀 anexo, 🤔 pergunta, 🙏 agradecimento). Síncrona, sem LLM, sem latência.
 *      Era 👀 fixo pra tudo, o que não dizia nada.
 *   2. FINAL — o modelo fecha a resposta com `REACT:<emoji>` numa linha própria e
 *      o sistema troca a reação pela que reflete o que aconteecu no turno. Custo
 *      zero: a escolha vem junto do texto que ele já estava escrevendo.
 *
 * Desligar: REACTIONS_ENABLED=0 no .env do tenant (default: ligado).
 */

/** A API do Telegram só aceita este conjunto em ReactionTypeEmoji. */
const TELEGRAM_REACTION_EMOJIS: ReadonlySet<string> = new Set([
  "👍", "👎", "❤", "🔥", "🥰", "👏", "😁", "🤔", "🤯", "😱", "🤬", "😢", "🎉",
  "🤩", "🤮", "💩", "🙏", "👌", "🕊", "🤡", "🥱", "🥴", "😍", "🐳", "❤‍🔥",
  "🌚", "🌭", "💯", "🤣", "⚡", "🍌", "🏆", "💔", "🤨", "😐", "🍓", "🍾", "💋",
  "🖕", "😈", "😴", "😭", "🤓", "👻", "👨‍💻", "👀", "🎃", "🙈", "😇", "😨",
  "🤝", "✍", "🤗", "🫡", "🎅", "🎄", "☃", "💅", "🤪", "🗿", "🆒", "💘", "🙉",
  "😎", "👾", "🤷‍♂", "🤷", "🤷‍♀", "😡",
])

/** Prefixo tolerante: o modelo troca o glifo do marcador; quem valida é a allowlist. */
const REACT_MARKER = /\S*REACT:\s*(\S+)\s*$/u

export function reactionsEnabled(): boolean {
  return process.env.REACTIONS_ENABLED !== "0"
}

/** Normaliza (tira variation selector) e valida contra a allowlist do Telegram. */
export function normalizeReactionEmoji(raw: string): string | null {
  const e = raw.trim().replace(/️/g, "")
  return TELEGRAM_REACTION_EMOJIS.has(e) ? e : null
}

/** Reação de chegada, pelo tipo do que veio. */
export function receiptReaction(msg: any, text = ""): string {
  const t = (text || msg?.text || msg?.caption || "").trim().toLowerCase()
  if (/\b(urgente|corre|é pra (agora|já)|e pra (agora|ja)|rápido|rapido)\b/.test(t)) return "⚡"
  if (msg?.voice || msg?.audio) return "✍"
  if (Array.isArray(msg?.photo) || msg?.document) return "👀"
  if (/\b(valeu|obrigad|brigad|vlw|agradeç|gratid)/.test(t)) return "🙏"
  if (/\b(boa|top|mandou bem|perfeito|ótimo|otimo|show|isso a[ií])\b/.test(t)) return "🔥"
  if (t.endsWith("?") || /^(o que|qual|quais|quando|onde|como|por que|porque|quem|será)\b/.test(t)) return "🤔"
  return "👀"
}

/**
 * Separa o marcador de reação final do texto da resposta. Sem marcador (ou com
 * emoji fora da allowlist), devolve o texto intacto e emoji null.
 */
export function splitReactMarker(reply: string): { texto: string; emoji: string | null } {
  const m = reply.match(REACT_MARKER)
  if (!m) return { texto: reply, emoji: null }
  const emoji = normalizeReactionEmoji(m[1]!)
  if (!emoji) return { texto: reply.replace(REACT_MARKER, "").trim(), emoji: null }
  return { texto: reply.replace(REACT_MARKER, "").trim(), emoji }
}
