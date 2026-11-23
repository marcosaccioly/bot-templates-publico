# __DA_NAME__ — container isolado do LifeOS do __PRINCIPAL_NAME__ (Docker rootless na VPS)
# Base = motor carimbado do Jão (motor-base-v6.0.0-2026.07.14), SEM segredos do operador.
# "Processo melhorado" (vs. tenant-b, tudo assado no BUILD, não curativo pós-lançamento):
#   nº1 patches no build (telegram sem ambiente do operador, VaultFreshness sem /mnt/d)
#   nº3 git persistente via entrypoint (a tenant-b perde git config em restart)
FROM oven/bun:1

USER root
RUN apt-get update && apt-get install -y --no-install-recommends \
      git curl jq ca-certificates ffmpeg tini \
    && rm -rf /var/lib/apt/lists/*

# usuário não-root próprio (motor tem 0 refs /home/operador hardcoded → home livre)
RUN useradd -m -s /bin/bash __TENANT__

# motor carimbado: o tarball extrai em /tmp/motor/tree → copiado pra ~/.claude do __TENANT__
ADD motor-base-v6.0.0-2026.07.14.tar.gz /tmp/motor/
RUN mkdir -p /home/__TENANT__/.claude \
    && cp -a /tmp/motor/tree/. /home/__TENANT__/.claude/ \
    && rm -rf /tmp/motor

# scaffold de identidade do __PRINCIPAL_NAME__/__DA_NAME__ (sobrepõe LIFEOS/USER)
COPY user-__TENANT__/ /home/__TENANT__/.claude/LIFEOS/USER/
# daidentity do __DA_NAME__ (nome + voz) — voice.ts lê de settings.json
COPY settings.__TENANT__.json /home/__TENANT__/.claude/settings.json
# ── PATCHES ASSADOS NO BUILD (correção nº1 — lição multi-tenant) ──
# telegram.ts: 6 pontos do ambiente do operador neutralizados (prompt + runtime)
COPY patches/telegram.ts /home/__TENANT__/.claude/LIFEOS/PULSE/modules/telegram.ts
# VaultFreshness: varre ~/vault via LIFEOS_VAULT_DIR, zero /mnt/d
COPY patches/VaultFreshness.hook.ts /home/__TENANT__/.claude/hooks/VaultFreshness.hook.ts
COPY gitconfig.__TENANT__ /home/__TENANT__/.claude/.gitconfig
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh && chown -R __TENANT__:__TENANT__ /home/__TENANT__

USER __TENANT__
WORKDIR /home/__TENANT__/.claude
ENV HOME=/home/__TENANT__
ENV LIFEOS_DIR=/home/__TENANT__/.claude/LIFEOS

# deps do Pulse (node_modules foi excluído do snapshot por peso)
RUN cd /home/__TENANT__/.claude/LIFEOS/PULSE && (bun install --frozen-lockfile || bun install) || true

# tini como PID1 → entrypoint (git config persistente no volume → exec pulse)
ENTRYPOINT ["/usr/bin/tini","--","/usr/local/bin/entrypoint.sh"]
