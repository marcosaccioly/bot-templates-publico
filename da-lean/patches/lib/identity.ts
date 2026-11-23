/**
 * identity.ts — resolve QUEM FALA com o __DA_NAME__.
 *
 * Adaptado do padrão do repo-bot (patches/lib/identity.ts), simplificado: aqui
 * não há grafo de círculos/governança — só um roster chat_id → nome + papel.
 * Três papéis: `dono` (quem o bot atende, __PRINCIPAL_NAME__), `arquiteto` (quem construiu e mantém
 * o bot) e `visitante` (qualquer outro chat_id autorizado que não esteja no
 * roster). Quem não consta é visitante — o bot NÃO chuta papel nem expõe dado
 * sensível do negócio.
 *
 * Fonte: roster.md (tabela markdown | Nome | chat_id | Papel | Nota |) no
 * identity dir (fixo, fora do workspace de projetos). Semeado pelo entrypoint na
 * 1ª subida e editável a quente — o cache invalida por mtime.
 */
import { readFileSync, statSync } from "fs"

export type Papel = "dono" | "arquiteto" | "visitante"

export interface Speaker {
  chatId: number
  /** nome do roster, ou o first_name do Telegram como fallback */
  nome: string
  papel: Papel
  /** true se o chat_id está no roster */
  identificado: boolean
  /** nota livre do roster (4ª coluna), se houver */
  nota: string
}

interface RosterEntry { nome: string; papel: Papel; nota: string }

// Cache leve com invalidação por mtime — evita reler o roster a cada turno sem
// servir dado velho quando o arquivo é editado.
let cache: { mtime: number; roster: Map<number, RosterEntry> } | null = null

function mtime(p: string): number {
  try { return statSync(p).mtimeMs } catch { return -1 }
}

function normalizaPapel(raw: string): Papel {
  const p = raw.toLowerCase()
  if (/arquitet|admin|t[eé]cnic|dev|engenhe/.test(p)) return "arquiteto"
  if (/dono|principal|owner/.test(p)) return "dono"
  return "visitante"
}

/** Parse da tabela markdown do roster: linhas `| Nome | chat_id | Papel | Nota |`. */
function parseRoster(text: string): Map<number, RosterEntry> {
  const map = new Map<number, RosterEntry>()
  for (const line of text.split("\n")) {
    if (!line.trimStart().startsWith("|")) continue
    const cols = line.split("|").map(c => c.trim())
    // cols[0] é vazio (antes da 1ª barra); nome=cols[1], chat_id=cols[2], papel=cols[3], nota=cols[4]
    const nome = cols[1]
    const idRaw = (cols[2] ?? "").replace(/[^\d]/g, "")
    if (!nome || !idRaw) continue
    if (/^nome$/i.test(nome) || nome.startsWith("---")) continue // cabeçalho/separador
    const id = Number(idRaw)
    if (Number.isFinite(id) && id > 0) {
      map.set(id, { nome, papel: normalizaPapel(cols[3] ?? ""), nota: cols[4] ?? "" })
    }
  }
  return map
}

function load(rosterPath: string): Map<number, RosterEntry> {
  const mt = mtime(rosterPath)
  if (cache && cache.mtime === mt) return cache.roster
  let roster = new Map<number, RosterEntry>()
  try { roster = parseRoster(readFileSync(rosterPath, "utf8")) } catch { /* ausente → todos visitantes */ }
  cache = { mtime: mt, roster }
  return roster
}

/**
 * Resolve o falante a partir do chat_id e do first_name (fallback). Nunca lança
 * — roster ausente/malformado degrada pra "visitante".
 */
export function resolveSpeaker(chatId: number, fallbackNome: string, rosterPath: string): Speaker {
  const entry = load(rosterPath).get(chatId)
  if (!entry) {
    return { chatId, nome: fallbackNome || String(chatId), papel: "visitante", identificado: false, nota: "" }
  }
  return { chatId, nome: entry.nome, papel: entry.papel, identificado: true, nota: entry.nota }
}

/**
 * Linha "Quem está falando agora" pra injetar no system prompt a cada turno.
 * `principalName` é o dono/sujeito do negócio — o falante pode ou não
 * ser ele.
 */
export function speakerContextLine(s: Speaker, principalName: string): string {
  switch (s.papel) {
    case "dono":
      return `Quem fala agora: **${s.nome}** — quem o bot atende (${principalName} em pessoa). Voz de negócio: zero jargão técnico (nada de "commit/push/repositório/branch"), respostas curtas de celular, foco no conteúdo. É quem revisa e aprova o que você produz.`
    case "arquiteto":
      return `Quem fala agora: **${s.nome}** — o arquiteto que construiu você (não é ${principalName}). Com ele você PODE falar de sistema, versionamento, manutenção e git sem cortina, e atender pedidos técnicos/operacionais como engenheiro. Cuidado pra não confundir os papéis: o material e as decisões do negócio continuam sendo de ${principalName}, não dele — ele cuida da máquina, não é o dono do conteúdo.`
    default:
      return `Quem fala agora: **${s.nome}** — NÃO consta no roster (visitante). Trate com cautela: seja cordial e útil no que é público, mas NÃO exponha dados sensíveis do negócio (financeiro, notas fiscais, contatos, estratégia) sem ${principalName} ter autorizado, e não registre alterações em nome dele. Na dúvida, ofereça encaminhar a ${principalName}.`
  }
}
