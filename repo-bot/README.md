# repo-bot — bot de repositório (arquétipo "bot de projeto")

Extraído de bots em produção (v2 de 23/11/2026). Mais enxuto que o da-lean:
**sem identidade de principal — o "cérebro" É o repositório clonado**. Serve um
PROJETO/equipe, não uma pessoa.

## Como funciona

- **Loop principal = Telegram → git**: toda mensagem/mídia é sanitizada, gravada
  append-only em `inbox/raw/{dia}/` no vault e commit+push serializado (fila git).
  Além disso roda um turno SDK com `cwd=VAULT` pra responder.
- `settingSources: ["project"]` — só o `CLAUDE.md` do repo-vault, nunca "user".
- **Guardrails de tool** no próprio módulo: Read/Grep/Write restritos ao VAULT;
  regex proíbe `~/.claude`, `.env`, `curl`, `ssh`, `sudo`, porta `31337`, `/notify`.
- **Clone resiliente**: o entrypoint tenta clonar a cada 30s até a deploy key ser
  cadastrada no GitHub (dá pra subir o container antes de mexer no repo).
- **Grupos**: `TELEGRAM_ALLOWED_GROUPS` (ids negativos). Em grupo só acorda com
  @handle, nome de exibição, reply a ele ou comando. Grupo não liberado loga o id.
- **Recursos de conversa** (v2): fila por chat, reações 2 fases, streaming,
  `ENVIAR:` (anexa arquivo do repo), `ENVIAR PARA:`/`RECADO PARA:` com botão,
  voz opcional (ElevenLabs), roster por `BOT_ROSTER`. 
- `python3` na imagem: pra scripts de validação do cliente (opcional — remova do
  Dockerfile se o cliente não tiver).

## Instanciar

1. `../new-tenant.sh repo-bot <slug> --client-name C --project-name P --vault-repo R --gh-owner Z --bot-display-name D`
2. **Revisar o `SYSTEM_APPEND`** em `patches/telegram-repobot.ts` — os itens
   `[PERSONALIZE]` são a alma do bot (fontes de verdade, fluxos de registro, pastas
   imutáveis, regras de dado sensível).
3. `cp .env.example .env` e preencher (token BotFather, chat_ids, OAuth, Groq).
4. Gerar a deploy key (`deploy-keys/README.md`).
5. `docker compose build && docker compose up -d`; `docker cp` da chave pro volume.
