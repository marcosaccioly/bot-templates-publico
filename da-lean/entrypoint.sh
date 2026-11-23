#!/usr/bin/env bash
set -euo pipefail

# Identidade git local — commits do DA ficam registrados como
# "__PRINCIPAL_NAME__ Assistant", nunca como o operador. Push via credencial
# ESCOPADA: deploy keys SSH (uma por repo, ver .ssh/config) OU um fine-grained
# PAT limitado aos repos do workspace (GIT_HTTPS_TOKEN no .env) — nunca um
# token amplo da conta inteira.
git config --global user.name "${PRINCIPAL_NAME:-__PRINCIPAL_NAME__} Assistant"
git config --global user.email "assistant@__TENANT__.local"
git config --global --add safe.directory '*'
git config --global init.defaultBranch main
git config --global pull.ff only

# Modo HTTPS (alternativa às deploy keys): credential store do PRÓPRIO tenant
# (invariante 7 do README raiz), sem chave SSH nenhuma.
#   GIT_HTTPS_TOKEN  — um PAT só, vale pra todo github.com deste tenant.
#   GIT_HTTPS_TOKENS — multi-conta: "ownerA=tokenA ownerB=tokenB" (um PAT
#     escopado por dona/dono de repo; o clone embute o owner como username na
#     URL, e o credential store casa por username — cada repo usa o token certo).
if [ -n "${GIT_HTTPS_TOKEN:-}" ] || [ -n "${GIT_HTTPS_TOKENS:-}" ]; then
  git config --global credential.helper store
  : > "${HOME}/.git-credentials"
  chmod 600 "${HOME}/.git-credentials"
  if [ -n "${GIT_HTTPS_TOKEN:-}" ]; then
    printf 'https://x-access-token:%s@github.com\n' "${GIT_HTTPS_TOKEN}" >> "${HOME}/.git-credentials"
  fi
  for cred in ${GIT_HTTPS_TOKENS:-}; do
    cred_owner="${cred%%=*}"; cred_token="${cred#*=}"
    printf 'https://%s:%s@github.com\n' "${cred_owner}" "${cred_token}" >> "${HOME}/.git-credentials"
  done
fi

mkdir -p "${HOME}/state/telegram" "${HOME}/logs/telegram"

# Seed do roster de interlocutores (quem fala com o bot: dono / arquiteto /
# visitante). Vive no volume identity, editável a quente — mas o seed mora na
# área de código, porque o volume mascara o que a imagem traz em
# ${HOME}/identity. Só semeia se ausente — nunca sobrescreve roster já editado.
if [ ! -f "${HOME}/identity/roster.md" ] && [ -f "${HOME}/assistant/roster.seed.md" ]; then
  cp "${HOME}/assistant/roster.seed.md" "${HOME}/identity/roster.md"
fi

# Self-healing: garante que cada projeto do workspace é um clone git de
# verdade (não uma cópia estática). Se a pasta ainda não é um repo git —
# 1ª subida de um volume novo — clona fresco (SSH via alias do .ssh/config,
# ou HTTPS se GIT_HTTPS_TOKEN estiver setado). Se já é um repo git, não mexe —
# preserva qualquer commit local do DA ainda não sincronizado.
clone_if_needed() {
  local dir="$1" alias="$2" repo="$3"
  if [ ! -d "${dir}/.git" ]; then
    rm -rf "${dir}"
    if [ -n "${GIT_HTTPS_TOKENS:-}" ]; then
      # owner na URL = chave de seleção do token no credential store
      local owner="${repo%%/*}"
      git clone "https://${owner}@github.com/${repo}.git" "${dir}"
    elif [ -n "${GIT_HTTPS_TOKEN:-}" ]; then
      git clone "https://github.com/${repo}.git" "${dir}"
    else
      git clone "${alias}:${repo}.git" "${dir}"
    fi
  else
    # Clone existente: atualiza com ff-only — NUNCA merge. Se divergiu ou a
    # árvore está suja, falha inofensivo e o boot segue com o estado local
    # (commit não sincronizado do DA nunca é sobrescrito). Sem isso, um repo
    # que ganhou conteúdo novo no remoto (ex.: identidade versionada) fica
    # eternamente preso no commit do primeiro clone. <!-- furo real 2026-07-20 -->
    git -C "${dir}" pull --ff-only || true
  fi
}

# WORKSPACE_REPOS (no .env): lista separada por espaço "alias=owner/repo",
# onde alias = Host do .ssh/config = nome da pasta no workspace.
# Ex.: WORKSPACE_REPOS="meu-projeto=acme/meu-projeto outro=acme/outro"
mkdir -p "${WORKSPACE_ROOT:-${HOME}/workspace}"
for entry in ${WORKSPACE_REPOS:-}; do
  alias="${entry%%=*}"; repo="${entry#*=}"
  clone_if_needed "${WORKSPACE_ROOT:-${HOME}/workspace}/${alias}" "${alias}" "${repo}"
done

# Roteador versionado (opcional): se WORKSPACE_CLAUDE_SRC apontar pra um
# arquivo (tipicamente dentro de um dos repos clonados — o "cérebro" do
# tenant), ele é a fonte da verdade do CLAUDE.md da raiz do workspace —
# materializado a cada boot, então editar no repo + rebuild/restart atualiza
# o roteador sem mexer em volume.
if [ -n "${WORKSPACE_CLAUDE_SRC:-}" ] && [ -f "${WORKSPACE_CLAUDE_SRC}" ]; then
  cp "${WORKSPACE_CLAUDE_SRC}" "${WORKSPACE_ROOT:-${HOME}/workspace}/CLAUDE.md"
fi

exec bun run "${HOME}/assistant/run.ts"
