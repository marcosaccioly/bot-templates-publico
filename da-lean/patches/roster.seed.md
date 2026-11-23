# Roster — quem fala com o __DA_NAME__

> Mapa `chat_id → nome + papel`. Confidencial (os chat_id não saem daqui).
> Papéis reconhecidos: `dono` (quem o bot atende, __PRINCIPAL_NAME__), `arquiteto` (quem construiu e
> mantém o __DA_NAME__), `visitante` (qualquer outro chat_id autorizado que não
> esteja listado aqui).
> Editável à mão — o __DA_NAME__ relê sozinho quando o arquivo muda (cache por mtime).
> Pra dar acesso a um sócio ou parceiro: adicione o chat_id na
> allowlist do `.env` E uma linha aqui; sem a linha, ele entra como `visitante`.
>
> ⚠️ PREENCHER na criação do tenant: os chat_id abaixo são placeholders. Pegue o
> id real de cada pessoa no primeiro "oi" dela (o bot loga `userId` de quem não
> está autorizado) e troque. Enquanto o número estiver errado, a pessoa cai como
> `visitante` — o bot não chuta papel.

| Nome | chat_id | Papel | Nota |
|------|---------|-------|------|
| __PRINCIPAL_NAME__ | 000000000 | dono | Quem o bot atende; revisa e aprova o que ele produz |
| Operador | 000000000 | arquiteto | Construiu e mantém o __DA_NAME__; fala de sistema/manutenção sem cortina |
