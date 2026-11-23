# Assistente do __PRINCIPAL_NAME__ — container isolado, Docker rootless na VPS.
# Bem mais magro que o outros tenants: SEM tarball motor-base do LifeOS (sem
# Algorithm/hooks/skills/Pulse dashboard). Só o módulo Telegram podado +
# identidade/memória escopadas + os workspaces ICM do __PRINCIPAL_NAME__.
#
# Separação código vs. estado (lição aprendida do tenant-a — lá o volume
# nomeado mascarava o código da imagem em rebuild):
#   - CÓDIGO (assistant/) fica só na imagem — sempre fresco a cada build.
#   - ESTADO (identity/, workspace/, state/, logs/) fica em volumes nomeados,
#     seedados da imagem no primeiro `up` e preservados em rebuilds depois.
FROM oven/bun:1

USER root
RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates tini openssh-client \
    && rm -rf /var/lib/apt/lists/*

RUN useradd -m -s /bin/bash __TENANT__

# ── Código (sempre baked no build) ──
COPY patches/package.json /home/__TENANT__/assistant/package.json
COPY patches/telegram.ts /home/__TENANT__/assistant/telegram.ts
COPY patches/run.ts /home/__TENANT__/assistant/run.ts
COPY patches/lib/ /home/__TENANT__/assistant/lib/
# Seed do roster (quem fala com o bot) fica na área de CÓDIGO — o volume
# identity mascararia o que viesse pela imagem; o entrypoint copia pro volume
# se ainda não existir (ver entrypoint.sh).
COPY patches/roster.seed.md /home/__TENANT__/assistant/roster.seed.md

# ── Seeds de estado (só usados na 1ª subida — volume vazio herda isto,
#    volume existente em rebuild NÃO é tocado) ──
COPY identity-seed/ /home/__TENANT__/identity/
COPY workspace-seed/ /home/__TENANT__/workspace/
# SSH config + known_hosts (não-secreto) — as chaves privadas em si NUNCA vão
# na imagem, são copiadas direto no volume via `docker cp` (ver README).
COPY ssh-seed/config /home/__TENANT__/.ssh/config
COPY ssh-seed/known_hosts /home/__TENANT__/.ssh/known_hosts

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
# Seed state/logs/.ssh dirs so the named volumes inherit __TENANT__:__TENANT__ ownership
# on first mount instead of Docker's root-owned empty-volume default.
RUN mkdir -p /home/__TENANT__/state/telegram /home/__TENANT__/logs/telegram \
    && chmod +x /usr/local/bin/entrypoint.sh \
    && chmod 700 /home/__TENANT__/.ssh \
    && chmod 600 /home/__TENANT__/.ssh/config /home/__TENANT__/.ssh/known_hosts \
    && chown -R __TENANT__:__TENANT__ /home/__TENANT__

USER __TENANT__
WORKDIR /home/__TENANT__/assistant
ENV HOME=/home/__TENANT__

RUN bun install

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
