# Deploy key — NUNCA commitada, NUNCA na imagem

Uma única chave, escopada SÓ ao repo-vault do cliente.

```bash
# 1. Gerar
ssh-keygen -t ed25519 -f deploy-keys/__TENANT__-deploy -N "" -C "__TENANT__-vault-deploy"

# 2. Cadastrar __TENANT__-deploy.pub como Deploy Key (com write) no repo
#    __GH_OWNER__/__VAULT_REPO_NAME__ no GitHub.

# 3. Depois do 1º `docker compose up -d`, copiar a chave PRIVADA direto pro volume
#    (o entrypoint fica tentando clonar a cada 30s até a chave funcionar):
docker cp deploy-keys/__TENANT__-deploy __TENANT__-bot:/home/__TENANT__/.ssh/__TENANT__-deploy
docker exec -u root __TENANT__-bot chown __TENANT__:__TENANT__ /home/__TENANT__/.ssh/__TENANT__-deploy
docker exec -u root __TENANT__-bot chmod 600 /home/__TENANT__/.ssh/__TENANT__-deploy
```
