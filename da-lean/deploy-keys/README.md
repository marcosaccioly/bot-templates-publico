# Deploy keys — NUNCA commitadas, NUNCA na imagem

Uma chave por repo do workspace (escopo mínimo: cada chave só alcança o próprio repo).

```bash
# 1. Gerar (uma por repo; <alias> = mesmo nome usado em WORKSPACE_REPOS e no ssh-seed/config)
ssh-keygen -t ed25519 -f deploy-keys/<alias> -N "" -C "__TENANT__-<alias>-deploy"

# 2. Cadastrar <alias>.pub como Deploy Key (com write) no repo GitHub correspondente.

# 3. Adicionar o bloco Host <alias> no ssh-seed/config (IdentityFile ~/.ssh/<alias>).

# 4. Depois do 1º `docker compose up -d`, copiar a chave PRIVADA direto pro volume
#    (nunca via imagem — camadas de imagem vazam):
docker cp deploy-keys/<alias> __TENANT__:/home/__TENANT__/.ssh/<alias>
docker exec -u root __TENANT__ chown __TENANT__:__TENANT__ /home/__TENANT__/.ssh/<alias>
docker exec -u root __TENANT__ chmod 600 /home/__TENANT__/.ssh/<alias>
docker restart __TENANT__
```
