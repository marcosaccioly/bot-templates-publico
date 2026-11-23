#!/usr/bin/env bash
# new-tenant.sh — instancia um tenant a partir de um template.
#
# Uso:
#   ./new-tenant.sh <lifeos-full|da-lean|repo-bot> <tenant-slug> [opções]
#
# Opções (todas opcionais; placeholder não fornecido fica visível pra editar à mão):
#   --da-name X           nome do DA (ex.: tenant-a)
#   --principal-name Y    nome do principal/cliente humano (ex.: tenant-a)
#   --gh-owner Z          conta GitHub dona dos repos (ex.: acme)
#   --client-name C       (repo-bot) nome do cliente/organização
#   --project-name P      (repo-bot) nome do projeto/sistema
#   --vault-repo R        (repo-bot) nome do repo-vault (sem owner)
#   --bot-handle H        (repo-bot) @handle do bot no Telegram
#   --bot-display-name D  (repo-bot) nome de exibição do bot
#   --dest DIR            destino (default: ~/tenants/<slug>)
#
# Exemplos:
#   ./new-tenant.sh lifeos-full maria --da-name Iris --principal-name Maria
#   ./new-tenant.sh da-lean joao --da-name Norte --principal-name João --gh-owner acme
#   ./new-tenant.sh repo-bot acme-kb --client-name "Acme" --project-name "Base Acme" \
#       --vault-repo acme-kb --gh-owner acme --bot-display-name "Acme KB Bot"
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"

tpl="${1:?informe o template: lifeos-full | da-lean | repo-bot}"; shift
tenant="${1:?informe o tenant-slug (minúsculo, sem espaço)}"; shift
[[ "$tenant" =~ ^[a-z][a-z0-9-]*$ ]] || { echo "slug inválido (use [a-z][a-z0-9-]*): $tenant" >&2; exit 1; }

da_name="" principal_name="" gh_owner="" client_name="" project_name=""
vault_repo="" bot_handle="" bot_display="" dest="$HOME/tenants/$tenant"
while [ $# -gt 0 ]; do case "$1" in
  --da-name)          da_name="$2"; shift 2 ;;
  --principal-name)   principal_name="$2"; shift 2 ;;
  --gh-owner)         gh_owner="$2"; shift 2 ;;
  --client-name)      client_name="$2"; shift 2 ;;
  --project-name)     project_name="$2"; shift 2 ;;
  --vault-repo)       vault_repo="$2"; shift 2 ;;
  --bot-handle)       bot_handle="$2"; shift 2 ;;
  --bot-display-name) bot_display="$2"; shift 2 ;;
  --dest)             dest="$2"; shift 2 ;;
  *) echo "opção desconhecida: $1" >&2; exit 1 ;;
esac; done

[ -d "$here/$tpl" ] || { echo "template não existe: $tpl" >&2; exit 1; }
[ -e "$dest" ] && { echo "destino já existe, não sobrescrevo: $dest" >&2; exit 1; }

mkdir -p "$(dirname "$dest")"
cp -r "$here/$tpl" "$dest"

# tarball do motor (só lifeos-full; o Dockerfile faz ADD dele no build)
if [ "$tpl" = "lifeos-full" ]; then
  cp "$here"/assets/motor-base-*.tar.gz "$dest/"
fi

# renomeia arquivos/pastas com __TENANT__ no nome
find "$dest" -depth -name '*__TENANT__*' | while read -r f; do
  mv "$f" "$(dirname "$f")/$(basename "$f" | sed "s/__TENANT__/$tenant/g")"
done

# substitui só os placeholders fornecidos (valores não podem conter "|")
sub() {
  local ph="$1" val="${2:-}"
  if [ -n "$val" ]; then
    find "$dest" -type f ! -name '*.tar.gz' -print0 | xargs -0 sed -i "s|$ph|$val|g"
  fi
}
da_name_lc="$(printf '%s' "$da_name" | tr '[:upper:]' '[:lower:]')"
sub __TENANT__ "$tenant"
sub __DA_NAME__ "$da_name"
sub __DA_NAME_LC__ "$da_name_lc"
sub __PRINCIPAL_NAME__ "$principal_name"
sub __GH_OWNER__ "$gh_owner"
sub __CLIENT_NAME__ "$client_name"
sub __PROJECT_NAME__ "$project_name"
sub __VAULT_REPO_NAME__ "$vault_repo"
sub __BOT_HANDLE__ "$bot_handle"
sub __BOT_DISPLAY_NAME__ "$bot_display"

echo "✔ tenant '$tenant' criado em $dest (template: $tpl)"
echo
left="$(grep -rIhoE '__[A-Z_]+__' "$dest" 2>/dev/null | sort -u || true)"
if [ -n "$left" ]; then
  echo "Placeholders ainda NÃO resolvidos (edite à mão ou re-rode com as flags):"
  echo "$left" | sed 's/^/  /'
  echo
fi
echo "Próximos passos (manuais — build/up é decisão do operador):"
echo "  1. cp $dest/.env.example $dest/.env   e preencher (NUNCA commitar o .env)"
case "$tpl" in
  lifeos-full) echo "  2. preencher $dest/user-$tenant/ (identidade do principal e do DA) e revisar settings.$tenant.json (voz)" ;;
  da-lean)     echo "  2. preencher identity-seed/, workspace-seed/CLAUDE.md, WORKSPACE_REPOS no .env e gerar deploy keys (deploy-keys/README.md)" ;;
  repo-bot)    echo "  2. revisar o bloco SYSTEM_APPEND em patches/telegram-repobot.ts ([PERSONALIZE]) e gerar a deploy key (deploy-keys/README.md)" ;;
esac
echo "  3. cd $dest && docker compose build && docker compose up -d"
