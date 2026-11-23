#!/usr/bin/env bash
set -uo pipefail

# Identidade git do bot — commits ficam registrados como o bot, nunca como
# uma pessoa. Push via deploy key escopada SÓ ao repo de __CLIENT_NAME__ (.ssh/config).
git config --global user.name "__BOT_DISPLAY_NAME__"
git config --global user.email "bot@__TENANT__.local"
git config --global --add safe.directory '*'
git config --global init.defaultBranch main
git config --global pull.ff only

mkdir -p "${HOME}/state/telegram" "${HOME}/logs/telegram"

VAULT="${VAULT_DIR:-${HOME}/vault}"

# Espera o vault existir: clona via deploy key; se a key ainda não foi
# cadastrada no GitHub, loga e tenta de novo (o vault também pode ser
# semeado por docker cp — o loop detecta o .git e segue).
until [ -d "${VAULT}/.git" ]; do
  echo "[entrypoint] vault ausente — tentando clonar __VAULT_REPO_NAME__…"
  # VAULT é o mountpoint do volume — limpa o CONTEÚDO (não o diretório) pra
  # deixar vazio pro clone. O vault também pode ser semeado por docker cp:
  # se o .git aparecer durante o sleep, o loop sai sem apagar nada.
  find "${VAULT}" -mindepth 1 -delete 2>/dev/null || true
  if git clone __VAULT_REPO_NAME__:__GH_OWNER__/__VAULT_REPO_NAME__.git "${VAULT}"; then
    break
  fi
  echo "[entrypoint] clone falhou (deploy key já cadastrada no repo?). Nova tentativa em 30s."
  sleep 30
done

# Garante que o push vai pela deploy key (mesmo num vault semeado por docker cp,
# que pode ter vindo com remote HTTPS).
git -C "${VAULT}" remote set-url origin __VAULT_REPO_NAME__:__GH_OWNER__/__VAULT_REPO_NAME__.git || true

# Vault fresco a cada subida: o bot só puxa quando ele mesmo commita, então o
# que chegou no GitHub com ele parado ficaria
# de fora até a próxima edição. --ff-only: com commit local pendente, não
# mexe — o próximo turno resolve com o pull --rebase de sempre.
git -C "${VAULT}" pull --ff-only -q origin main \
  || echo "[entrypoint] pull na subida não foi fast-forward — segue com o vault local."

exec bun run "${HOME}/assistant/run.ts"
