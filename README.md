# bot-templates — moldes de bot de Telegram com Claude, um container por bot

Moldes extraídos de bots que rodam em produção numa VPS: cada bot (tenant) vive
no seu próprio container Docker rootless, conversa pelo Telegram e usa o Claude
(via Claude Agent SDK) como cérebro. Mais um roteiro guiado pra montar a VPS do zero.

## Por onde começar

1. **VPS nova** → `vps/preparar-vps.sh` (guiado, ver `vps/README.md`).
2. **Primeiro bot** → escolha o molde abaixo e rode `./new-tenant.sh`.

## Os dois moldes

| Molde | O que é | Cérebro | Cobrança |
|-------|---------|---------|----------|
| **repo-bot** | Bot de um PROJETO/equipe/coletivo (mesma linhagem do bot de uma cooperativa em produção): o "cérebro" é um repositório git clonado. DM + grupos, fila por chat, reações, envio de arquivos, voz opcional | o próprio repo (`CLAUDE.md` do projeto) | `CLAUDE_CODE_OAUTH_TOKEN` (assinatura Claude) |
| **da-lean** | Assistente enxuto de uma PESSOA num escopo de trabalho: identidade/memória em 2 arquivos + workspace multi-repo | `identity/` (2 .md lidos por turno) | `ANTHROPIC_API_KEY` (API) |

Escolha pela pergunta: *o bot serve um PROJETO/grupo (repo-bot) ou uma PESSOA
num escopo de trabalho (da-lean)?* Nenhum dos dois usa LifeOS.

## Uso

```bash
./new-tenant.sh repo-bot acme-kb --client-name "Acme" --project-name "Base Acme" \
    --vault-repo acme-kb --gh-owner acme --bot-handle AcmeBot \
    --bot-display-name "Acme Bot" --principal-name "Seu Nome"
./new-tenant.sh da-lean joao --da-name Norte --principal-name João --gh-owner acme
```

O script copia o molde pra `~/tenants/<slug>`, substitui os placeholders e lista
os que faltarem. Depois: preencher o `.env` (a partir do `.env.example`), revisar
os blocos `[PERSONALIZE]` e `docker compose build && docker compose up -d`.

## Placeholders

`__TENANT__` (slug, minúsculo) · `__DA_NAME__` / `__DA_NAME_LC__` ·
`__PRINCIPAL_NAME__` · `__GH_OWNER__` · e no repo-bot: `__CLIENT_NAME__`,
`__PROJECT_NAME__`, `__VAULT_REPO_NAME__`, `__BOT_HANDLE__`, `__BOT_DISPLAY_NAME__`.
Marcações `[PERSONALIZE]` pedem texto humano (a "alma" do bot).

## Invariantes de segurança (não relaxar ao instanciar)

1. **Só volumes NOMEADOS** — nenhum bind-mount do host, sem `docker.sock`.
2. **`no-new-privileges: true`** e usuário não-root próprio no container.
3. **Nenhuma porta publicada** — Telegram é long-polling (só saída).
4. **Segredos só via `.env`** (fora da imagem; `env_file` no compose). Chaves SSH
   privadas NUNCA na imagem — entram no volume via `docker cp` (ver `deploy-keys/README.md`).
5. **`tini` como PID1** → entrypoint → processo do bot.
6. **Código na imagem, estado em volume**: rebuild traz código novo sem perder conversa nem vault.
7. **Git com identidade própria do bot** e push só por credencial escopada
   (deploy key por repo).
8. **Docker rootless** no host e teto de CPU/memória por bot (`cpus:`/`mem_limit:`).

## Grupos no Telegram (repo-bot)

No BotFather: `/setjoingroups` → Enable e `/setprivacy` → Disable. Ponha o
chat_id do grupo (negativo) em `TELEGRAM_ALLOWED_GROUPS`; um grupo não liberado
aparece no log com o id. No grupo, o bot só responde quando é chamado: @handle,
o nome dele, reply a uma mensagem dele ou comando.
