# Estado do projeto GPTchat CNPJ

Projeto pausado em 3 de outubro de 2026 por solicitação do proprietário.

## Pronto no código

- Worker Cloudflare em modo híbrido: BrasilAPI para a primeira versão e base própria quando o snapshot estiver disponível.
- Formulário que mantém o CNPJ pontuado, inclusive `53.486.573/0001-43`.
- Cache de consultas no Workers KV.
- D1 para metadados operacionais e índices quentes.
- R2 `cnpjs` e Basin Catalog para ZIPs oficiais, Parquet/Iceberg e consultas Basin SQL.
- Pipeline mensal por GitHub Actions para descobrir a competência mais recente, baixar os ZIPs da Receita, ingerir, validar e promover o snapshot de forma atômica.
- Workflow manual de implantação do Worker.
- Testes TypeScript e Python passando localmente.

## Recursos já provisionados

- Worker `gptchat-cnpj`.
- D1 `cnpj-chat-db`.
- KV `cnpj-chat-cache`.
- R2 `cnpjs` com Basin Catalog habilitado.
- Credenciais Cloudflare de R2 e implantação criadas. Os valores não estão versionados.

## Pausado antes de executar

- Não iniciar a carga completa da Receita.
- Não executar o workflow de implantação.
- Não adicionar ou alterar segredos no GitHub sem nova autorização.
- Não substituir a versão atualmente publicada do Worker.

## Retomada

Quando houver autorização, o próximo passo é cadastrar os segredos privados do repositório, executar `implantar Worker`, validar o CNPJ de teste no ambiente ao vivo e depois iniciar `snapshot mensal CNPJ (Receita → Cloudflare)`.

