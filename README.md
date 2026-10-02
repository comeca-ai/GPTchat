# CNPJ Aberto — MVP Cloudflare

Chat de consulta aos dados públicos do CNPJ da Receita Federal, inspirado no acesso simples do cnpj.chat. Esta V1 interpreta perguntas em português, transforma-as em filtros seguros e consulta um snapshot versionado.

## Arquitetura

- **Workers**: API e interface web na borda.
- **D1**: índice relacional consultável (empresa, estabelecimento, sócio, Simples/MEI).
- **R2**: arquivos brutos e snapshots imutáveis da Receita; o D1 guarda apenas o índice necessário ao produto.
- **KV**: cache de consultas por 15 minutos.
- **Vectorize + Workers AI**: entendimento semântico de CNAEs e interpretação da pergunta. A V1 já declara os bindings; a busca relacional funciona sem depender do vetor.
- **Queues**: ingestão mensal assíncrona e retomável.

> Os dados são públicos, mas contêm dados pessoais de sócios. Mantenha finalidade legítima, fonte/data visíveis, correção e canal de contato; não trate a base como autorização para spam.

## Rodar localmente

```bash
npm install
npm run db:migrate:local
npm run db:seed
npm run dev
```

Abra `http://localhost:8787`. O seed contém somente dois registros fictícios/demonstrativos.

## Provisionar na Cloudflare

```bash
npx wrangler login
npx wrangler d1 create cnpj-chat-db
npx wrangler r2 bucket create cnpj-snapshots
npx wrangler kv namespace create CACHE
npx wrangler vectorize create cnpj-cnae-index --dimensions=1024 --metric=cosine
npx wrangler queues create cnpj-import
```

Copie os IDs retornados para `wrangler.jsonc`, rode `npm run db:migrate:remote` e depois `npm run deploy`.

## Pipeline mensal

O diagrama completo e as relações estão em `docs/data-model.md`. Para não exigir 85 GB livres, `pipeline/csv_to_r2.py` trabalha com um ZIP oficial por execução, gera Parquet ZSTD e envia ao R2. O workflow manual pode ser executado em matriz para os ~37 ZIPs da competência; cada job é retomável e independente.

Segredos do GitHub necessários: `R2_ENDPOINT`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` e `R2_BUCKET`. Nunca versionar esses valores.

Depois de promover as tabelas para Iceberg, altere `DATA_MODE` para `r2sql` e grave o token somente como segredo do Worker:

```bash
npx wrangler secret put R2_SQL_TOKEN
```

## Próximo incremento de produção

Ative o R2 Data Catalog no bucket e converta os Parquets para tabelas Iceberg; o produto consulta o conjunto completo com R2 SQL. A troca do snapshot ativo precisa ser atômica: só marque `ready` depois de validar contagens e amostras. Não force os 85 GB em um único D1.

Pipeline aberto usado como referência de formato e atualização: https://github.com/caiopizzol/cnpj-data-pipeline
