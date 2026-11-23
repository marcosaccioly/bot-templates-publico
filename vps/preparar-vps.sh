#!/usr/bin/env bash
# preparar-vps.sh — monta uma VPS pra hospedar bots (tenants).
#
# O que faz, passo a passo e perguntando antes de cada um:
#   1. atualiza o sistema e instala o básico
#   2. cria o seu usuário (com sudo) — você não trabalha como root
#   3. instala a sua chave SSH nesse usuário
#   4. blinda o SSH (sem root, sem senha) — SÓ depois de você testar o login
#   5. firewall (ufw) + fail2ban + atualizações de segurança automáticas
#   6. swap (se a máquina tiver pouca memória)
#   7. Docker ROOTLESS (containers rodam sem root — cada bot isolado)
#   8. Bun + Claude Code + GitHub CLI no seu usuário
#   9. (opcional) baixa os moldes de bot (bot-templates)
#
# Uso (na VPS nova, Ubuntu 24.04, logado como root):
#   bash preparar-vps.sh              # guiado
#   bash preparar-vps.sh --simular    # só mostra o que faria, não muda nada
#
# Pode rodar de novo sem medo: cada passo confere se já está feito.

set -uo pipefail

SIMULAR=0
[ "${1:-}" = "--simular" ] && SIMULAR=1

LOG=/var/log/preparar-vps.log
[ "$SIMULAR" = 1 ] && LOG=/dev/null

# ── aparência ────────────────────────────────────────────────────────────────
if [ -t 1 ]; then
  B=$'\e[1m'; D=$'\e[2m'; G=$'\e[32m'; Y=$'\e[33m'; R=$'\e[31m'; C=$'\e[36m'; N=$'\e[0m'
else B= D= G= Y= R= C= N=; fi

titulo() { printf '\n%s━━ %s ━━%s\n' "$C$B" "$*" "$N"; }
info()   { printf '%s\n' "  $*"; }
ok()     { printf '%s\n' "  ${G}✔${N} $*"; }
aviso()  { printf '%s\n' "  ${Y}⚠${N} $*"; }
erro()   { printf '%s\n' "  ${R}✘${N} $*" >&2; }

# Executa (ou só mostra, em --simular). Tudo vai pro log.
run() {
  if [ "$SIMULAR" = 1 ]; then printf '  %s$ %s%s\n' "$D" "$*" "$N"; return 0; fi
  printf '\n$ %s\n' "$*" >>"$LOG"
  bash -c "$*" >>"$LOG" 2>&1
  local rc=$?
  [ $rc -ne 0 ] && erro "falhou (código $rc): $*  — detalhes em $LOG"
  return $rc
}

# Executa como o usuário novo, com a sessão systemd dele (precisa pro Docker rootless).
run_user() {
  local cmd="$*"
  run "sudo -iu '$USUARIO' env XDG_RUNTIME_DIR=/run/user/$UID_U DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$UID_U/bus bash -lc $(printf '%q' "$cmd")"
}

# Pergunta sim/não. $2 = padrão (s|n).
pergunta() {
  local p="$1" def="${2:-s}" r
  local hint="[S/n]"; [ "$def" = n ] && hint="[s/N]"
  while true; do
    read -r -p "  ${B}?${N} $p $hint " r </dev/tty || r=""
    r="${r:-$def}"
    case "${r,,}" in s|sim|y|yes) return 0 ;; n|nao|não|no) return 1 ;; esac
  done
}

ler() { # ler "texto" VAR [padrão]
  local p="$1" var="$2" def="${3:-}" r
  if [ -n "$def" ]; then read -r -p "  ${B}?${N} $p [$def] " r </dev/tty || r=""; r="${r:-$def}"
  else read -r -p "  ${B}?${N} $p " r </dev/tty || r=""; fi
  printf -v "$var" '%s' "$r"
}

pausa() { read -r -p "  ${D}(Enter pra continuar)${N} " _ </dev/tty || true; }

# ── 0. pré-condições ─────────────────────────────────────────────────────────
titulo "Preparar VPS"
[ "$SIMULAR" = 1 ] && aviso "MODO SIMULAÇÃO — nada vai ser alterado, só mostro os comandos."

if [ "$(id -u)" -ne 0 ] && [ "$SIMULAR" = 0 ]; then
  erro "rode como root (ex.: ssh root@IP-DA-VPS e depois: bash preparar-vps.sh)"
  exit 1
fi

. /etc/os-release 2>/dev/null || true
if [ "${ID:-}" != ubuntu ] || [ "${VERSION_ID:-}" != "24.04" ]; then
  aviso "este roteiro foi feito pra Ubuntu 24.04 — aqui é: ${PRETTY_NAME:-desconhecido}"
  pergunta "seguir mesmo assim?" n || exit 1
else
  ok "sistema: $PRETTY_NAME"
fi

IP_VPS="$(hostname -I 2>/dev/null | awk '{print $1}')"
info "IP desta máquina: ${B}${IP_VPS:-?}${N}"
info "Log completo: $LOG"
[ "$SIMULAR" = 0 ] && { : >"$LOG"; chmod 600 "$LOG"; }

ler "nome do seu usuário nesta VPS (minúsculo, sem espaço)" USUARIO "andre"
[[ "$USUARIO" =~ ^[a-z][a-z0-9_-]*$ ]] || { erro "nome inválido: $USUARIO"; exit 1; }

# ── 1. sistema ───────────────────────────────────────────────────────────────
titulo "1/9 · Atualizar o sistema"
if pergunta "atualizar pacotes e instalar o básico (git, curl, ufw, fail2ban…)?"; then
  export DEBIAN_FRONTEND=noninteractive
  run "apt-get update -q"
  run "DEBIAN_FRONTEND=noninteractive apt-get -y -q upgrade"
  run "DEBIAN_FRONTEND=noninteractive apt-get -y -q install git curl ca-certificates gnupg jq unzip python3 \
       uidmap dbus-user-session slirp4netns ufw fail2ban unattended-upgrades tzdata"
  run "timedatectl set-timezone America/Sao_Paulo"
  ok "sistema atualizado (fuso America/Sao_Paulo)"
fi

# ── 2. usuário ───────────────────────────────────────────────────────────────
titulo "2/9 · Seu usuário"
if id "$USUARIO" >/dev/null 2>&1; then
  ok "usuário $USUARIO já existe"
else
  info "Vou criar ${B}$USUARIO${N} com permissão de administrador (sudo)."
  run "adduser --disabled-password --gecos '' '$USUARIO'"
  run "usermod -aG sudo '$USUARIO'"
  ok "usuário criado"
fi
info "O sudo vai pedir uma senha desse usuário. Ela NÃO serve pra entrar por SSH"
info "(isso será só por chave) — é só pra comandos de administrador. Anote num cofre."
if [ "$SIMULAR" = 0 ] && ! passwd -S "$USUARIO" 2>/dev/null | awk '{exit ($2=="P")?0:1}'; then
  pergunta "definir a senha de sudo agora?" s && passwd "$USUARIO" </dev/tty
else
  ok "usuário já tem senha (ou simulação)"
fi
UID_U="$(id -u "$USUARIO" 2>/dev/null || echo 1000)"
HOME_U="$(getent passwd "$USUARIO" | cut -d: -f6)"; HOME_U="${HOME_U:-/home/$USUARIO}"

# ── 3. chave SSH ─────────────────────────────────────────────────────────────
titulo "3/9 · Sua chave SSH"
AK="$HOME_U/.ssh/authorized_keys"
if [ -s "$AK" ]; then
  ok "$USUARIO já tem $(grep -c . "$AK") chave(s) autorizada(s)"
elif [ -s /root/.ssh/authorized_keys ] && pergunta "copiar a(s) chave(s) que o root já tem (as que você cadastrou no painel da hospedagem)?"; then
  run "install -d -m 700 -o '$USUARIO' -g '$USUARIO' '$HOME_U/.ssh'"
  run "install -m 600 -o '$USUARIO' -g '$USUARIO' /root/.ssh/authorized_keys '$AK'"
  ok "chave copiada"
else
  cat <<EOF

  Entrar por SSH vai ser SÓ com chave (sem senha). Se você ainda não tem uma,
  no SEU computador (não aqui), rode:

      ${B}ssh-keygen -t ed25519 -C "$USUARIO@vps"${N}

  (Enter em tudo; se quiser, ponha uma frase-senha.) Depois mostre a chave PÚBLICA:

      ${B}cat ~/.ssh/id_ed25519.pub${N}          (Windows: type %USERPROFILE%\\.ssh\\id_ed25519.pub)

  Ela começa com "ssh-ed25519 AAAA…". Cole a linha inteira abaixo.
  ${D}(A chave PRIVADA — o arquivo sem .pub — nunca sai do seu computador.)${N}

EOF
  ler "cole a chave pública:" CHAVE
  if [[ "$CHAVE" =~ ^(ssh-ed25519|ssh-rsa|ecdsa-sha2-[a-z0-9-]+|sk-ssh-ed25519@openssh.com)\ [A-Za-z0-9+/=]+ ]]; then
    run "install -d -m 700 -o '$USUARIO' -g '$USUARIO' '$HOME_U/.ssh'"
    run "printf '%s\n' $(printf '%q' "$CHAVE") >> '$AK' && chown '$USUARIO:$USUARIO' '$AK' && chmod 600 '$AK'"
    ok "chave instalada"
  else
    erro "isso não parece uma chave pública SSH — pulo este passo (rode o script de novo depois)"
  fi
fi

# ── 4. blindar SSH ───────────────────────────────────────────────────────────
titulo "4/9 · Blindar o SSH"
# Nome com 01- de propósito: no sshd vale o PRIMEIRO valor lido, e a hospedagem
# costuma deixar um 50-cloud-init.conf com "PasswordAuthentication yes".
BLIND=/etc/ssh/sshd_config.d/01-preparar-vps.conf
if [ -f "$BLIND" ] || { [ "$SIMULAR" = 0 ] && sshd -T 2>/dev/null | grep -qx 'passwordauthentication no' && sshd -T 2>/dev/null | grep -qx 'permitrootlogin no'; }; then
  ok "SSH já blindado ($BLIND)"
elif [ ! -s "$AK" ] && [ "$SIMULAR" = 0 ]; then
  aviso "sem chave autorizada pro $USUARIO — NÃO vou blindar (você ficaria trancado pra fora)"
else
  cat <<EOF

  Antes de desligar o login por senha e o root, prove que a chave funciona.
  ${B}Sem fechar esta janela${N}, abra OUTRO terminal no seu computador e rode:

      ${B}ssh $USUARIO@${IP_VPS:-IP-DA-VPS}${N}

  Tem que entrar sem pedir senha de login (pode pedir a frase-senha da chave).

EOF
  if pergunta "entrou certinho pelo outro terminal?" n; then
    run "cat > '$BLIND' <<'CONF'
# preparar-vps.sh — login só por chave, nunca como root
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
CONF"
    if run "sshd -t"; then
      run "systemctl try-reload-or-restart ssh"
      if [ "$SIMULAR" = 1 ] || { sshd -T | grep -qx 'passwordauthentication no' && sshd -T | grep -qx 'permitrootlogin no'; }; then
        ok "SSH blindado: root bloqueado, senha desligada"
      else
        aviso "gravei a config, mas o sshd ainda mostra senha/root ligado — confira: sshd -T | grep -Ei 'password|rootlogin'"
      fi
    else
      run "rm -f '$BLIND'"
      erro "config do SSH não validou — desfiz, nada mudou"
    fi
  else
    aviso "ok, deixei como está. Resolva o login por chave e rode o script de novo."
  fi
fi

# ── 5. firewall e proteção ───────────────────────────────────────────────────
titulo "5/9 · Firewall, fail2ban e atualizações automáticas"
info "Bot de Telegram não precisa de porta aberta (ele só faz chamadas pra fora)."
if pergunta "ativar o firewall liberando só o SSH?"; then
  run "ufw allow OpenSSH"
  if pergunta "vai hospedar SITE nesta VPS (abrir 80/443)?" n; then
    run "ufw allow 80/tcp && ufw allow 443/tcp"
  fi
  run "ufw --force enable"
  ok "firewall ativo"
fi
if pergunta "ativar fail2ban (bane quem tenta adivinhar login) e atualizações de segurança automáticas?"; then
  run "cat > /etc/fail2ban/jail.d/sshd.local <<'CONF'
[sshd]
enabled = true
backend = systemd
CONF"
  run "systemctl enable --now fail2ban && systemctl restart fail2ban"
  run "echo 'unattended-upgrades unattended-upgrades/enable_auto_updates boolean true' | debconf-set-selections && dpkg-reconfigure -f noninteractive unattended-upgrades"
  ok "fail2ban + atualizações automáticas ligados"
fi

# ── 6. swap ──────────────────────────────────────────────────────────────────
titulo "6/9 · Swap"
MEM_MB=$(awk '/MemTotal/{print int($2/1024)}' /proc/meminfo)
if swapon --show 2>/dev/null | grep -q .; then
  ok "já tem swap"
elif [ "$MEM_MB" -lt 6000 ] && pergunta "a VPS tem ${MEM_MB} MB de RAM — criar 2 GB de swap (evita o bot morrer por falta de memória)?"; then
  run "fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile"
  run "grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab"
  ok "swap de 2 GB criado"
else
  info "RAM suficiente (${MEM_MB} MB) — sem swap."
fi

# ── 7. Docker rootless ───────────────────────────────────────────────────────
titulo "7/9 · Docker (rootless)"
info "Cada bot roda num container isolado, e o Docker roda SEM root — um bot"
info "comprometido não vira dono da máquina."
if pergunta "instalar Docker rootless pro $USUARIO?"; then
  if ! command -v dockerd-rootless-setuptool.sh >/dev/null 2>&1; then
    run "install -m 0755 -d /etc/apt/keyrings"
    run "curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc && chmod a+r /etc/apt/keyrings/docker.asc"
    run "echo \"deb [arch=\$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu \$(. /etc/os-release && echo \$VERSION_CODENAME) stable\" > /etc/apt/sources.list.d/docker.list"
    run "apt-get update -q"
    run "DEBIAN_FRONTEND=noninteractive apt-get -y -q install docker-ce docker-ce-cli containerd.io docker-compose-plugin docker-buildx-plugin docker-ce-rootless-extras"
  fi
  # Docker do sistema (root) desligado: só o rootless do usuário.
  run "systemctl disable --now docker.service docker.socket || true"
  run "rm -f /var/run/docker.sock"
  # Deixa o usuário limitar CPU/memória dos containers (cpus: / mem_limit: do compose).
  run "mkdir -p /etc/systemd/system/user@.service.d && printf '[Service]\nDelegate=cpu cpuset io memory pids\n' > /etc/systemd/system/user@.service.d/delegate.conf && systemctl daemon-reload"
  # Sessão do usuário viva mesmo sem ninguém logado (bots 24h).
  run "loginctl enable-linger '$USUARIO'"
  run "systemctl start user@$UID_U.service"
  if [ "$SIMULAR" = 1 ] || [ ! -S "/run/user/$UID_U/docker.sock" ]; then
    run_user "dockerd-rootless-setuptool.sh install"
  fi
  run_user "systemctl --user enable --now docker"
  run "grep -q DOCKER_HOST '$HOME_U/.bashrc' || echo 'export DOCKER_HOST=unix:///run/user/\$(id -u)/docker.sock' >> '$HOME_U/.bashrc'"
  if run_user "DOCKER_HOST=unix:///run/user/$UID_U/docker.sock docker run --rm hello-world"; then
    ok "Docker rootless funcionando (hello-world rodou)"
  else
    aviso "o teste do Docker falhou — veja o log; costuma resolver com reboot e rodar de novo"
  fi
fi

# ── 8. ferramentas ───────────────────────────────────────────────────────────
titulo "8/9 · Bun, Claude Code e GitHub CLI"
if pergunta "instalar Bun + Claude Code + GitHub CLI?"; then
  if [ ! -x "$HOME_U/.bun/bin/bun" ]; then
    run_user "curl -fsSL https://bun.sh/install | bash"
  fi
  run_user "~/.bun/bin/bun install -g @anthropic-ai/claude-code@latest"
  if ! command -v gh >/dev/null 2>&1; then
    run "install -m 0755 -d /etc/apt/keyrings"
    run "curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli.gpg && chmod a+r /etc/apt/keyrings/githubcli.gpg"
    run "echo \"deb [arch=\$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli.gpg] https://cli.github.com/packages stable main\" > /etc/apt/sources.list.d/github-cli.list"
    run "apt-get update -q && DEBIAN_FRONTEND=noninteractive apt-get -y -q install gh"
  fi
  ok "ferramentas instaladas"
  info "Atualizar o Claude Code depois: ${B}bun install -g @anthropic-ai/claude-code@latest${N}"
  info "(${Y}não${N} use 'claude update' — ele procura o npm, que não existe aqui)"
fi

# ── 9. moldes de bot ─────────────────────────────────────────────────────────
titulo "9/9 · Moldes de bot (bot-templates)"
TPL="$HOME_U/tenants/_templates"
if [ -d "$TPL/.git" ]; then
  ok "moldes já baixados em $TPL"
elif pergunta "baixar os moldes de bot agora?"; then
  run_user "mkdir -p ~/tenants && git clone https://github.com/marcosaccioly/bot-templates-publico.git ~/tenants/_templates"
  if [ "$SIMULAR" = 1 ]; then ok "(simulação) moldes iriam pra $TPL"
  elif [ -d "$TPL/.git" ]; then ok "moldes em $TPL (atualizar depois: git -C ~/tenants/_templates pull)"
  else aviso "não consegui baixar — veja o log"; fi
fi
info "GitHub CLI: rode ${B}gh auth login${N} como $USUARIO quando for criar o repo-cérebro do primeiro bot."

# ── resumo ───────────────────────────────────────────────────────────────────
titulo "Pronto"
cat <<EOF
  Daqui pra frente, entre sempre como ${B}$USUARIO${N}:

      ${B}ssh $USUARIO@${IP_VPS:-IP-DA-VPS}${N}

  Conferir a máquina:   ${B}docker ps${N} · ${B}sudo ufw status${N} · ${B}free -h${N}
  Primeiro bot:         ${B}cd ~/tenants/_templates && cat README.md${N}
                        (./new-tenant.sh repo-bot <nome> … — o README explica)
  Usar o Claude Code:   ${B}claude${N}  (na 1ª vez ele pede login na sua conta Claude)

  Log do que foi feito: $LOG
EOF
[ "$SIMULAR" = 0 ] && [ -f /var/run/reboot-required ] && aviso "o sistema pede reboot (kernel novo): sudo reboot"
exit 0
