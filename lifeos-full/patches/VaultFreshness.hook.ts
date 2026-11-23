#!/usr/bin/env bun
/**
 * VaultFreshness — SessionStart hook que mantém os repos do vault sincronizados
 * com o remoto antes de o DA consultar (nunca ler retrato defasado).
 *
 * Adaptado pro ambiente multi-repo do tenant: varre cada repositório git sob
 * ~/vault (LIFEOS_VAULT_DIR). O __PRINCIPAL_NAME__ pode editar os repos, então
 * puxamos antes de consultar. Conservador: só ff-pull se limpo + na main.
 * Qualquer erro → stderr + exit 0 (nunca bloqueia a sessão).
 */

import { existsSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const VAULT_ROOT = process.env.LIFEOS_VAULT_DIR ?? join(process.env.HOME ?? "", "vault");
const CANONICAL_BRANCH = "main";

function git(repo: string, args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    timeout: 12000,
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function freshenRepo(repo: string, name: string): string {
  try {
    try {
      git(repo, ["fetch", "--quiet"]);
    } catch {
      /* offline — reporta dos refs conhecidos */
    }
    const branch = git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]);
    const dirty = git(repo, ["status", "--porcelain"]).length > 0;
    let upstream = "origin/main";
    try {
      upstream = git(repo, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
    } catch {
      /* sem upstream */
    }
    let behind = 0;
    let ahead = 0;
    try {
      const [a, b] = git(repo, ["rev-list", "--left-right", "--count", `HEAD...${upstream}`])
        .split(/\s+/)
        .map((n) => parseInt(n, 10) || 0);
      ahead = a;
      behind = b;
    } catch {
      /* upstream desconhecido */
    }
    let action = "atualizado";
    if (behind > 0) {
      if (!dirty && branch === CANONICAL_BRANCH) {
        try {
          git(repo, ["pull", "--ff-only", "--quiet"]);
          action = `ff-pull (${behind})`;
          behind = 0;
        } catch {
          action = `${behind} atrás, ff-pull falhou — não forcei`;
        }
      } else {
        action = `${behind} atrás, ${dirty ? "árvore suja" : "fora da main"} — não puxei`;
      }
    }
    return `${name}: ${branch} · ${behind}↓/${ahead}↑ · ${action}${dirty ? " · suja" : ""}`;
  } catch (e) {
    return `${name}: erro (${(e as Error)?.message || String(e)})`;
  }
}

function main(): void {
  try {
    if (!existsSync(VAULT_ROOT)) process.exit(0);
    const repos = readdirSync(VAULT_ROOT, { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(join(VAULT_ROOT, d.name, ".git")))
      .map((d) => d.name);
    if (repos.length === 0) process.exit(0);
    const lines = repos.map((name) => freshenRepo(join(VAULT_ROOT, name), name));
    process.stdout.write(
      `<vault-freshness>\n${lines.join("\n")}\n` +
        `Antes de ler/editar um repo do vault, confira que diz "atualizado" na 'main'.\n` +
        `</vault-freshness>\n`,
    );
  } catch (e) {
    process.stderr.write(`VaultFreshness error: ${(e as Error)?.message || String(e)}\n`);
  }
  process.exit(0);
}

main();
