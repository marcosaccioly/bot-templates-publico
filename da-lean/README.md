# da-lean — DA enxuto SEM LifeOS (arquétipo "DA enxuto")

Base viva: **tenant-c**. Sem motor-base: só o módulo Telegram podado +
identidade/memória em 2 arquivos + workspace multi-repo com deploy keys escopadas.
O mais barato de operar (API key direta, sem assinatura).

## Como funciona

- `patches/telegram.ts` — grammY polling, allowlist, sessão SDK com
  resume, streaming, transcrição Groq. Sem Algorithm/hooks/skills/voz-out/BM25.
- **SDK 0.3.216** (porte 2026-07-20, validado no bot vivo do operador): watchdog de
  inatividade (180s de silêncio real + hard cap 15min, no lugar do timeout de parede),
  clear de sessão sob demanda (`/clear`, `/nova`, "nova sessão"), `AskUserQuestion`
  bloqueado (travava o turno no Telegram), `skills: []` (trim de contexto) e captura
  determinística de anexos via `INBOX_DIR` (opt-in no `.env` — aponte pra dentro de
  um repo do workspace pra versionar anexo + nota-irmã).
- **Identidade**: `identity-seed/{DA_IDENTITY,PRINCIPAL_IDENTITY}.md` → volume
  `-identity` (seedado na 1ª subida). Lidos INTEIROS a cada turno e injetados no
  system prompt — manter curtos.
- **Memória**: bullets append-only na seção `## Memory-System Proposals` no rodapé
  dos dois .md, escritos pelo próprio modelo (Edit tool). Sem tiers, sem aprovação.
- **Workspace multi-projeto**: `cwd` = pasta-pai com `CLAUDE.md` roteador; cada
  projeto é um clone git REAL. Repos declarados em `WORKSPACE_REPOS` no `.env`
  (`alias=owner/repo`, separado por espaço) — o entrypoint clona o que faltar no boot.
  ⚠️ O README do tenant-c vivo ficou defasado nisso ("sem git por desenho") — o desenho
  atual é ESTE: git de verdade via deploy key escopada por repo.
- **Separação código/estado**: código só na imagem; identity/workspace/state/logs/.ssh
  em volumes nomeados.

## Instanciar

1. `../new-tenant.sh da-lean <slug> --da-name X --principal-name Y --gh-owner Z`
2. Preencher `identity-seed/` e `workspace-seed/CLAUDE.md`.
3. `cp .env.example .env` — preencher `ANTHROPIC_API_KEY`, bot, `WORKSPACE_REPOS`.
4. Gerar deploy keys (`deploy-keys/README.md`) e espelhar os aliases no `ssh-seed/config`.
5. `docker compose build && docker compose up -d`; depois `docker cp` das chaves pro volume.
