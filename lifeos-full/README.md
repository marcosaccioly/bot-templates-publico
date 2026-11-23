# lifeos-full — LifeOS completo containerizado (arquétipo "como o Jão")

Base viva: **tenant-a** (o "processo melhorado" — tudo assado no BUILD).
Roda o **Pulse inteiro** (`pulse.ts`) sobre o motor-base carimbado, com
identidade/TELOS do principal e voz ElevenLabs.

## Peças

- `Dockerfile` — `ADD` do tarball do motor → `~/.claude`; patches assados no build.
- `entrypoint.sh` — 3 correções: git config persistente (o volume mascara o da
  imagem), symlink `LifeOS→LIFEOS` (~70 refs mixed-case do motor), `sed` do modelo
  no `PULSE.toml` (Sonnet 5 principal + Opus fallback; SDK recusa main==fallback).
- `patches/telegram.ts` — 6 neutralizações do ambiente do operador (vault genérico,
  prompts com o nome do principal, sem Google Drive/venv, auto-aprovação por `/vault/`).
- `patches/VaultFreshness.hook.ts` — varre `~/vault`, zero `/mnt/d`.
- `settings.__TENANT__.json` — `daidentity` (nome + voz). ⚠️ Voz default = Adam
  (placeholder inglês) — trocar por voz pt-BR do principal.
- `user-__TENANT__/` — scaffold de identidade (DA, principal, TELOS, projetos).
  Preencher antes do build, ou rodar `/interview` dentro do container depois.

## Instanciar

1. `../new-tenant.sh lifeos-full <slug> --da-name X --principal-name Y`
2. Preencher `user-<slug>/` e revisar `settings.<slug>.json` (voiceId).
3. `cp .env.example .env` e preencher — o `CLAUDE_CODE_OAUTH_TOKEN` deve ser **do
   próprio principal** (`claude setup-token`), nunca OAuth-ponte do operador
   (dívida conhecida do tenant-a vivo; custo cai na conta errada).
4. `docker compose build && docker compose up -d` (manual, operador).

## Gotchas herdados (já resolvidos no template, não regredir)

- Volume `<slug>-claude` mascara o que veio na imagem → toda config que precisa
  sobreviver a restart é reescrita no boot pelo entrypoint (idempotente).
- `bun install` do Pulse roda no build (node_modules fica fora do tarball por peso).
- Vault do principal começa vazio e cresce com o uso (`<slug>-vault`).
