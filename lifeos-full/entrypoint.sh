#!/usr/bin/env bash
set -euo pipefail

# ── Correção nº3 (dívida da tenant-b): git config persistente ──────────────────
# O volume nomeado __TENANT__-claude monta em ~/.claude e MASCARA o que veio na
# imagem — então o .gitconfig copiado no build fica escondido no 1º boot.
# Reescrevemos a config global (no volume) a CADA boot: sobrevive a restart.
export GIT_CONFIG_GLOBAL="${HOME}/.claude/.gitconfig"
git config --global user.name  "__DA_NAME__"
git config --global user.email "__DA_NAME_LC__@__TENANT__.lifeos"
git config --global credential.helper "store --file=${HOME}/.claude/.git-credentials"
git config --global --add safe.directory '*'
git config --global init.defaultBranch main
git config --global pull.ff only

# ── Bug de casing LifeOS/LIFEOS (mesmo fix do Jão vivo) ────────────────────
# O motor tem ~70 refs a ~/.claude/LifeOS (mixed-case), incl. telegram.ts:106
# (LIFEOS_DIR) que injeta a identidade. A árvore viva é LIFEOS (all-caps).
# No motor-base, LifeOS veio como diretório CONGELADO → troca por symlink pra
# LIFEOS, resolvendo todas as refs de uma vez. Idempotente.
if [ -e "${HOME}/.claude/LifeOS" ] && [ ! -L "${HOME}/.claude/LifeOS" ]; then
  rm -rf "${HOME}/.claude/LifeOS"
fi
[ -L "${HOME}/.claude/LifeOS" ] || ln -s "${HOME}/.claude/LIFEOS" "${HOME}/.claude/LifeOS"

# ── Modelo do __DA_NAME__ = Sonnet 5 (operador 15/07) ────────────────────────────
# Tenant de outra pessoa → Sonnet 5 corta o custo do Opus sem perder qualidade
# de conversa. Config vive no volume → forçamos no boot. Idempotente (2ª run
# não acha "opus-4-8"). Só a linha `model`, não o `fallback_model`.
sed -i 's/^model = "claude-opus-4-8"/model = "claude-sonnet-5"/' \
  "${HOME}/.claude/LIFEOS/PULSE/PULSE.toml" 2>/dev/null || true
# fallback TEM que ser != do principal (o SDK recusa main==fallback). Como o
# principal agora é sonnet-5, o fallback (que vinha sonnet-5) passa a opus-4-8.
sed -i 's/^fallback_model = "claude-sonnet-5"/fallback_model = "claude-opus-4-8"/' \
  "${HOME}/.claude/LIFEOS/PULSE/PULSE.toml" 2>/dev/null || true

# vault do __PRINCIPAL_NAME__ começa vazio; garante o diretório pra o clone-on-demand
mkdir -p "${HOME}/vault"

exec bun run "${HOME}/.claude/LIFEOS/PULSE/pulse.ts"
