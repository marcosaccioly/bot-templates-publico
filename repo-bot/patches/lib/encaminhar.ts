/**
 * encaminhar.ts — mandar arquivo ou recado para OUTRA pessoa (2026-11-21)
 *
 * Spec: .bot/config.md do vault, "mandar arquivo/recado para outra pessoa".
 *
 * O modelo pede com uma linha própria (mesmo desenho do `ENVIAR:` e do `REACT:`):
 *   ENVIAR PARA: <Nome> | <caminho do arquivo> [| <contexto opcional>]
 *   RECADO PARA: <Nome> | <texto curto>
 * O sistema tira a linha do texto, resolve o nome pelo roster (só quem está na
 * whitelist), e pergunta a quem pediu com botões Mandar / Cancelar. Só entrega
 * no Mandar. O chat_id nunca vai pro modelo, nunca aparece em mensagem nem no log.
 */

import { appendFile, realpath } from "fs/promises"
import { relative, sep } from "path"
import { listRoster } from "./identity"
import { resolveAttachment, type ResolvedAttachment } from "./attachments"

export type PedidoTipo = "arquivo" | "recado"

export interface PedidoEnvio {
  tipo: PedidoTipo
  nome: string
  /** caminho do arquivo (arquivo) ou texto do recado (recado) */
  conteudo: string
  /** linha de contexto opcional (só no arquivo) */
  contexto: string
}

/** Recado é curto por definição; texto maior que isso vira arquivo. */
export const MAX_RECADO_CHARS = 1500

// Linha própria; prefixo colado tolerado (ex.: "📎ENVIAR PARA:"), igual aos outros marcadores.
const MARKER = /^[^\S\n]*\S*?(ENVIAR|RECADO)[^\S\n]+PARA:[^\S\n]*(.+?)[^\S\n]*$/gmu

const limpa = (s: string) => s.trim().replace(/^[`"'<]+|[`"'>]+$/g, "").trim()

/** Separa as linhas `ENVIAR PARA:` / `RECADO PARA:` do texto. */
export function splitForwardMarkers(reply: string): { texto: string; pedidos: PedidoEnvio[]; malformados: string[] } {
  const pedidos: PedidoEnvio[] = []
  const malformados: string[] = []
  const texto = reply.replace(MARKER, (linha, kind: string, resto: string) => {
    const i = resto.indexOf("|")
    if (i < 0) { malformados.push(linha.trim()); return "" }
    const nome = limpa(resto.slice(0, i))
    const depois = resto.slice(i + 1)
    if (kind === "RECADO") {
      const recado = depois.trim()
      if (!nome || !recado) { malformados.push(linha.trim()); return "" }
      pedidos.push({ tipo: "recado", nome, conteudo: recado, contexto: "" })
    } else {
      const j = depois.indexOf("|")
      const caminho = limpa(j < 0 ? depois : depois.slice(0, j))
      const contexto = j < 0 ? "" : depois.slice(j + 1).trim()
      if (!nome || !caminho) { malformados.push(linha.trim()); return "" }
      pedidos.push({ tipo: "arquivo", nome, conteudo: caminho, contexto })
    }
    return ""
  })
  if (pedidos.length === 0 && malformados.length === 0) return { texto: reply, pedidos, malformados }
  return { texto: texto.replace(/\n{3,}/g, "\n\n").trim(), pedidos, malformados }
}

/** Sem acento, minúsculo, espaços colapsados. */
export function normalizaNome(s: string): string {
  return s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/^@/, "").replace(/\s+/g, " ").trim()
}

export type Resolucao =
  | { ok: true; chatId: number; nome: string }
  | { ok: false; motivo: "nao-achei" | "ambiguo"; candidatos: string[] }

/**
 * Resolve o nome pelo roster, restrito à whitelist. Casa o nome inteiro ou o
 * primeiro nome (ex.: "Maria Souza" → Maria). Sem prefixo solto: "Mar"
 * não vira Gabi nem Gabriel.
 */
export function resolveDestinatario(nomePedido: string, vault: string, allowed: Set<number>): Resolucao {
  const alvo = normalizaNome(nomePedido)
  const roster = listRoster(vault).filter(r => allowed.has(r.chatId))
  if (!alvo) return { ok: false, motivo: "nao-achei", candidatos: [] }
  let hits = roster.filter(r => normalizaNome(r.name) === alvo)
  if (hits.length === 0) {
    const primeiro = alvo.split(" ")[0]
    hits = roster.filter(r => {
      const n = normalizaNome(r.name)
      return n === primeiro || n.split(" ")[0] === alvo
    })
  }
  // mesma pessoa listada duas vezes no roster não é ambiguidade
  const porId = new Map(hits.map(h => [h.chatId, h.name]))
  if (porId.size === 1) {
    const [[chatId, nome]] = [...porId.entries()]
    return { ok: true, chatId, nome }
  }
  if (porId.size > 1) return { ok: false, motivo: "ambiguo", candidatos: [...porId.values()] }
  return { ok: false, motivo: "nao-achei", candidatos: [] }
}

/**
 * Mesmas travas do `ENVIAR:` (dentro do vault, arquivo regular, até 50 MB) e
 * mais: nada de `.bot/`, `.git/`, `.env*`, nem arquivo/pasta oculta.
 */
export async function resolveArquivoParaOutro(raw: string, vault: string): Promise<ResolvedAttachment & { rel: string }> {
  const anexo = await resolveAttachment(raw, vault)
  const rel = relative(await realpath(vault), anexo.path)
  const partes = rel.split(sep)
  if (partes.some(p => p.startsWith("."))) throw new Error("é um arquivo interno, que não sai daqui")
  if (partes.some(p => /^\.?env(\..*)?$/i.test(p))) throw new Error("é um arquivo interno, que não sai daqui")
  return { ...anexo, rel }
}

/** Pedido já resolvido, esperando o Mandar/Cancelar de quem pediu. */
export interface EnvioPendente {
  id: string
  criadoEm: number
  /** quem pediu (só pra conferir no clique; nunca vai pra texto nem log) */
  solicitanteId: number
  solicitanteNome: string
  destinatarioId: number
  destinatarioNome: string
  tipo: PedidoTipo | "encaminhado"
  /** arquivo: caminho absoluto já validado · recado: texto · encaminhado: file_id do Telegram */
  conteudo: string
  /** nome que aparece pra quem recebe */
  rotulo: string
  /** caminho relativo ao vault, pro log (arquivo) */
  caminhoLog: string
  contexto: string
  /** chat onde a confirmação foi mostrada (pode ser grupo) */
  origemChatId: number
  origemMsgId: number
}

/** Confirmação vale por 1 hora; depois o botão diz que expirou. */
export const PENDENTE_TTL_MS = 60 * 60 * 1000
const pendentes = new Map<string, EnvioPendente>()

export function guardaPendente(p: Omit<EnvioPendente, "id" | "criadoEm">): EnvioPendente {
  const agora = Date.now()
  for (const [k, v] of pendentes) if (agora - v.criadoEm > PENDENTE_TTL_MS) pendentes.delete(k)
  const id = `${agora.toString(36)}${Math.random().toString(36).slice(2, 6)}`
  const full = { ...p, id, criadoEm: agora }
  pendentes.set(id, full)
  return full
}

/** Tira e devolve o pendente (um clique só consome). */
export function pegaPendente(id: string): EnvioPendente | null {
  const p = pendentes.get(id)
  if (!p) return null
  if (Date.now() - p.criadoEm > PENDENTE_TTL_MS) { pendentes.delete(id); return null }
  return p
}
export function removePendente(id: string) { pendentes.delete(id) }

export function textoConfirmacao(p: EnvioPendente): string {
  const o = p.tipo === "recado" ? `o recado "${p.conteudo}"`
    : p.rotulo === "uma foto" ? "a foto" : `o arquivo ${p.rotulo}`
  return `📤 Vou mandar ${o} para ${p.destinatarioNome}, no privado. Confirma?`
}

/** Cabeçalho de quem recebe: quem pediu + o que é + uma linha de contexto. */
export function cabecalhoRecebedor(p: EnvioPendente): string {
  const o = p.tipo === "recado" ? "um recado" : p.rotulo
  const ctx = p.contexto
    ? p.contexto
    : "Veio de uma conversa com o assistente de __CLIENT_NAME__. Se quiser falar sobre isso, é só me responder aqui."
  const corpo = p.tipo === "recado" ? `\n\n${p.conteudo}` : ""
  return `${p.solicitanteNome} pediu pra te mandar: ${o}${corpo}\n\n${ctx}`
}

/** Erro do Telegram que significa "não dá pra puxar conversa com essa pessoa". */
export function erroSemConversa(err: unknown): boolean {
  const s = String((err as any)?.description ?? (err as any)?.message ?? err)
  const code = Number((err as any)?.error_code ?? 0)
  return code === 403 || /chat not found|bot was blocked|user is deactivated|can't initiate|bot can't/i.test(s)
}

/** Uma linha JSON por evento de envio. Sem chat_id. */
export async function logEnvio(arquivoLog: string, p: EnvioPendente, status: string, erro?: string) {
  const linha = {
    ts: new Date().toISOString(),
    status,
    quem_pediu: p.solicitanteNome,
    para: p.destinatarioNome,
    tipo: p.tipo,
    arquivo: p.tipo === "recado" ? undefined : (p.caminhoLog || p.rotulo),
    recado: p.tipo === "recado" ? p.conteudo.slice(0, 300) : undefined,
    erro: erro?.slice(0, 200),
  }
  await appendFile(arquivoLog, JSON.stringify(linha) + "\n").catch(() => {})
}
