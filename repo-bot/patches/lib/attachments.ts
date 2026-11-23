/**
 * attachments.ts — anexos de SAÍDA do tenant-c (2026-09-25)
 *
 * O modelo pede pra mandar um arquivo fechando a resposta com uma ou mais
 * linhas `ENVIAR: <caminho>` (mesmo desenho do `REACT:`). O sistema tira essas
 * linhas do texto e anexa cada arquivo com sendDocument depois da resposta.
 *
 * Trava: só sai arquivo que mora DENTRO do workspace (resolvido com realpath,
 * então symlink e `..` não furam), arquivo regular, até o limite da Bot API.
 */

import { realpath, stat } from "fs/promises"
import { basename, isAbsolute, join, sep } from "path"

/** Bot API: upload de documento vai até 50 MB. */
export const MAX_DOCUMENT_BYTES = 50 * 1024 * 1024

/** Linha própria; prefixo colado tolerado (ex.: "📎ENVIAR:"), igual ao REACT. */
const SEND_MARKER = /^[^\S\n]*\S*ENVIAR:[^\S\n]*(.+?)[^\S\n]*$/gmu

/** Separa as linhas `ENVIAR:` do texto. Sem marcador, devolve o texto intacto. */
export function splitSendMarkers(reply: string): { texto: string; paths: string[] } {
  const paths: string[] = []
  const texto = reply.replace(SEND_MARKER, (_m, p: string) => {
    const limpo = p.trim().replace(/^[`"'<]+|[`"'>]+$/g, "")
    if (limpo) paths.push(limpo)
    return ""
  })
  if (paths.length === 0) return { texto: reply, paths }
  return { texto: texto.replace(/\n{3,}/g, "\n\n").trim(), paths }
}

export interface ResolvedAttachment {
  path: string
  name: string
  size: number
}

/**
 * Resolve o caminho pedido (absoluto, ou relativo à raiz do workspace) e
 * valida. Lança Error com motivo legível pro usuário se não puder enviar.
 */
export async function resolveAttachment(raw: string, workspaceRoot: string): Promise<ResolvedAttachment> {
  const candidate = isAbsolute(raw) ? raw : join(workspaceRoot, raw)
  let real: string
  try {
    real = await realpath(candidate)
  } catch {
    throw new Error("arquivo não encontrado")
  }
  const root = await realpath(workspaceRoot)
  if (!real.startsWith(root + sep)) throw new Error("fica fora da área de trabalho")
  const st = await stat(real)
  if (!st.isFile()) throw new Error("não é um arquivo")
  if (st.size === 0) throw new Error("arquivo vazio")
  if (st.size > MAX_DOCUMENT_BYTES) throw new Error("passa de 50 MB, limite do Telegram")
  return { path: real, name: basename(real), size: st.size }
}
