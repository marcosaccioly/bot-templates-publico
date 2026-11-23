# Bot do __PROJECT_NAME__ — container isolado, Docker rootless na VPS.
# Padrão tenant-c (o mais enxuto da casa): SEM motor-base do LifeOS — só o módulo
# Telegram do repo-bot + o vault clonado via deploy key escopada.
#
# Separação código vs. estado (lição do tenant-a):
#   - CÓDIGO (assistant/) só na imagem — sempre fresco a cada build.
#   - ESTADO (vault/, state/, logs/, .ssh/) em volumes nomeados — sobrevive a rebuild.
FROM oven/bun:1

USER root
RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates tini openssh-client python3 tzdata \
    && rm -rf /var/lib/apt/lists/*

RUN useradd -m -s /bin/bash __TENANT__

# ── Código (baked no build) ──
COPY patches/package.json /home/__TENANT__/assistant/package.json
COPY patches/run.ts /home/__TENANT__/assistant/run.ts
COPY patches/telegram-repobot.ts /home/__TENANT__/assistant/telegram-repobot.ts
COPY patches/lib/ /home/__TENANT__/assistant/lib/

# SSH config + known_hosts (não-secretos). A chave privada NUNCA vai na
# imagem — entra no volume via `docker cp` (ver README).
COPY ssh-seed/config /home/__TENANT__/.ssh/config
COPY ssh-seed/known_hosts /home/__TENANT__/.ssh/known_hosts

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN mkdir -p /home/__TENANT__/state/telegram /home/__TENANT__/logs/telegram /home/__TENANT__/vault \
    && chmod +x /usr/local/bin/entrypoint.sh \
    && chmod 700 /home/__TENANT__/.ssh \
    && chmod 600 /home/__TENANT__/.ssh/config /home/__TENANT__/.ssh/known_hosts \
    && chown -R __TENANT__:__TENANT__ /home/__TENANT__

USER __TENANT__
WORKDIR /home/__TENANT__/assistant
ENV HOME=/home/__TENANT__

RUN bun install

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
