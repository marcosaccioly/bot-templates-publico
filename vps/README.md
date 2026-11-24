# vps/ — preparar uma VPS nova pra hospedar bots

`preparar-vps.sh` monta, guiado e perguntando antes de cada passo, a mesma base
da VPS do Marquito: Ubuntu 24.04, usuário próprio com sudo, SSH só por chave
(sem root, sem senha), ufw + fail2ban + atualizações automáticas, swap se a RAM
for pouca, **Docker rootless** (com delegação de CPU/memória pro `cpus:`/`mem_limit:`
do compose), Bun + Claude Code + GitHub CLI e, opcionalmente, o clone deste repo.

O que **não** faz: não instala LifeOS/Pulse, não copia nada da VPS do Marquito,
não mexe em domínio/nginx/certificado, não cria bot (isso é o `new-tenant.sh`).

## Rodar

Na VPS recém-criada (Ubuntu 24.04 limpo, sem painel nem apps), como root:

```bash
bash preparar-vps.sh --simular   # mostra tudo que faria, não muda nada
bash preparar-vps.sh             # de verdade
```

Pode rodar de novo: cada passo confere se já está feito. Log em `/var/log/preparar-vps.log`.

O passo de blindar o SSH só acontece depois de você confirmar que entrou com a
chave por OUTRO terminal — senão não desliga a senha (evita ficar trancado pra fora).

## Testado

Modo `--simular` percorrido inteiro (23/11/2026). Execução real feita pelo
André numa VPS limpa (24/11/2026) — passou. Se algo falhar, o log diz o
comando exato.
