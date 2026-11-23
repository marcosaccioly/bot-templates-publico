/**
 * identity.ts — resolve QUEM FALA (herdado do tenant-d; no repo-bot só o roster importa).
 *
 * Fonte única (v2): o próprio repo clonado (vault). Lê:
 *   - .bot/roster.md          chat_id → nome  (fonte humana, confidencial)
 *   - circulos/_grafo.json    nome → papéis/círculos que a pessoa energiza
 *
 * Devolve uma FATIA por pessoa (nunca o grafo inteiro) pra injetar no turno —
 * controle de custo/turno (ver plano-bot-v2). Estrutura é CONHECÍVEL: o bot
 * pode falar de círculos/papéis. O que NÃO sai da caixa: os chat_id em si e
 * PII sensível — isso é postura no SYSTEM_APPEND, não neste módulo.
 */

import { readFileSync, statSync } from "fs"
import { join } from "path"

export interface Speaker {
  chatId: number
  /** nome resolvido (roster) ou o first_name do Telegram como fallback */
  nome: string
  /** true se o chat_id está no roster */
  identificado: boolean
  /** papéis que a pessoa energiza no grafo: "Papel (Círculo)" */
  papeis: string[]
  /** papéis/nota textual do roster (fallback p/ quem ainda não está no grafo, ex.: Bruna em integração) */
  papelRoster: string
  /** em processo de integração à organização — ainda não é membro pleno de círculo */
  emIntegracao: boolean
}

interface GrafoPapel { nome: string; energizado_por?: string[] }
interface GrafoCirculo { nome: string; papeis?: Record<string, GrafoPapel> }
interface Grafo { circulos?: Record<string, GrafoCirculo> }

// Cache leve com invalidação por mtime — evita reler os arquivos a cada turno
// sem ficar servindo dado velho quando o vault é atualizado (git pull do bot).
interface RosterEntry { nome: string; papelRoster: string }
let cache: { rosterMtime: number; grafoMtime: number; roster: Map<number, RosterEntry>; grafo: Grafo } | null = null

function mtime(p: string): number {
  try { return statSync(p).mtimeMs } catch { return -1 }
}

/** Parse da tabela markdown do roster: linhas `| Nome | chat_id | Papéis |`. */
function parseRoster(text: string): Map<number, RosterEntry> {
  const map = new Map<number, RosterEntry>()
  for (const line of text.split("\n")) {
    if (!line.trimStart().startsWith("|")) continue
    const cols = line.split("|").map(c => c.trim())
    // cols[0] é vazio (antes da 1ª barra); nome=cols[1], chat_id=cols[2], papéis=cols[3]
    const nome = cols[1]
    const idRaw = (cols[2] ?? "").replace(/[^\d]/g, "") // ignora "*(pendente)*"
    const papelRoster = (cols[3] ?? "").replace(/`[^`]*`/g, "").trim() // tira refs `../arquivo.md`
    if (!nome || !idRaw) continue
    if (/^nome$/i.test(nome) || nome.startsWith("---")) continue // cabeçalho/separador
    const id = Number(idRaw)
    if (Number.isFinite(id) && id > 0) map.set(id, { nome, papelRoster })
  }
  return map
}

function load(vault: string): { roster: Map<number, RosterEntry>; grafo: Grafo } {
  const rosterPath = join(vault, ".bot", "roster.md")
  const grafoPath = join(vault, "circulos", "_grafo.json")
  const rMt = mtime(rosterPath)
  const gMt = mtime(grafoPath)
  if (cache && cache.rosterMtime === rMt && cache.grafoMtime === gMt) {
    return { roster: cache.roster, grafo: cache.grafo }
  }
  let roster = new Map<number, RosterEntry>()
  let grafo: Grafo = {}
  try { roster = parseRoster(readFileSync(rosterPath, "utf8")) } catch { /* roster ausente → todos não-identificados */ }
  // repo-bot: o repo guarda só dados, então o roster vem do env do tenant.
  // BOT_ROSTER="111111111:__PRINCIPAL_NAME__:operador,222222222:Fulana:cliente"
  for (const item of (process.env.BOT_ROSTER ?? "").split(",")) {
    const [idRaw, nome, papel] = item.split(":").map(x => (x ?? "").trim())
    const id = Number(idRaw)
    if (nome && Number.isFinite(id) && id > 0) roster.set(id, { nome, papelRoster: papel ?? "" })
  }
  try { grafo = JSON.parse(readFileSync(grafoPath, "utf8")) as Grafo } catch { /* grafo ausente → sem papéis */ }
  cache = { rosterMtime: rMt, grafoMtime: gMt, roster, grafo }
  return { roster, grafo }
}

/** Roster completo como [{chatId, name}] — alimenta o fan-out da deliberação
 *  (fonte única: substitui a env var DELIBERATION_ROSTER da v1). */
export function listRoster(vault: string): { chatId: number; name: string }[] {
  const { roster } = load(vault)
  return [...roster.entries()].map(([chatId, e]) => ({ chatId, name: e.nome }))
}

/** Papéis+círculos que `nome` energiza, no formato "Papel (Círculo)". */
function papeisDe(nome: string, grafo: Grafo): string[] {
  const out: string[] = []
  for (const c of Object.values(grafo.circulos ?? {})) {
    for (const p of Object.values(c.papeis ?? {})) {
      if ((p.energizado_por ?? []).includes(nome)) out.push(`${p.nome} (${c.nome})`)
    }
  }
  return out
}

/**
 * Resolve o falante a partir do chat_id do Telegram e do first_name (fallback).
 * Nunca lança — vault ausente/malformado degrada pra "não identificado".
 */
export function resolveSpeaker(chatId: number, fallbackNome: string, vault: string): Speaker {
  const { roster, grafo } = load(vault)
  const entry = roster.get(chatId)
  if (!entry) {
    return { chatId, nome: fallbackNome || String(chatId), identificado: false, papeis: [], papelRoster: "", emIntegracao: false }
  }
  const emIntegracao = /integra|colig/i.test(entry.papelRoster)
  return {
    chatId,
    nome: entry.nome,
    identificado: true,
    papeis: papeisDe(entry.nome, grafo),
    papelRoster: entry.papelRoster,
    emIntegracao,
  }
}

/**
 * Linha de contexto pra injetar no turno. Fatiada (só esta pessoa), curta.
 * "não identificado" é explícito — o bot não deve chutar papel de quem não
 * está no grafo.
 */
export function speakerContextLine(s: Speaker): string {
  if (!s.identificado) {
    return `Quem fala: ${s.nome} — ainda não consta no .bot/roster.md (trate com cuidado: responda, mas não registre material em nome dessa pessoa sem confirmar quem é).`
  }
  const p = s.papelRoster ? ` (${s.papelRoster})` : ""
  return `Quem fala: ${s.nome}${p}.`
}
