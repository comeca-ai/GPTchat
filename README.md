# GPTchat CNPJ — base própria na Cloudflare

Consulta de CNPJ em modo híbrido: BrasilAPI na primeira versão e snapshots próprios dos Dados Abertos da Receita Federal assim que a carga mensal estiver pronta.

## Arquitetura

- **Workers**: formulário, API, fallback BrasilAPI e consulta na borda.
- **R2**: ZIPs oficiais preservados e snapshots imutáveis.
- **Basin Catalog (R2 Data Catalog) + Iceberg**: tabelas completas em Parquet ZSTD.
- **Basin SQL**: consultas sobre o snapshot ativo.
- **D1**: catálogo operacional, feedback e índices quentes — não recebe a base inteira.
- **KV**: cache de consultas por 15 minutos.
- **Workers AI**: interpretação opcional de perguntas; a consulta direta de CNPJ não depende de IA.
- **Vectorize e Queues**: próximos incrementos para busca semântica e ingestão assíncrona.
- **GitHub Actions**: atualização mensal, retomável e sem máquina local.

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
npx wrangler r2 bucket create cnpjs
npx wrangler r2 bucket catalog enable cnpjs
npx wrangler kv namespace create CACHE
```

Os recursos `cnpjs`, `cnpj-chat-db` e `cnpj-chat-cache` já foram provisionados. Grave `BASIN_SQL_TOKEN` e `CF_ACCOUNT_ID` como segredos do Worker e depois execute `npm run deploy`.

## Pipeline mensal

O workflow `.github/workflows/monthly-snapshot.yml` roda no dia 15 de cada mês e também pode ser iniciado manualmente. Ele:

1. descobre a competência completa mais recente no servidor oficial da Receita;
2. distribui os ZIPs entre jobs independentes;
3. preserva cada ZIP no R2 e grava os CSVs como tabelas Iceberg;
4. valida todos os marcadores e tabelas;
5. atualiza `catalog/active.json` somente depois de o snapshot estar completo.

Assim, uma carga parcial nunca substitui a base que está atendendo o Worker.

Segredos do GitHub necessários:

- `R2_ENDPOINT`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` e `R2_BUCKET`;
- `R2_CATALOG_URI`, `R2_WAREHOUSE` e `R2_CATALOG_TOKEN`.
- `BASIN_SQL_TOKEN`, `CLOUDFLARE_API_TOKEN` e `CLOUDFLARE_ACCOUNT_ID` para a implantação.

O token do catálogo precisa de leitura e escrita no R2 e no Basin Catalog. Nunca versionar esses valores.

O Worker usa `DATA_MODE=hybrid`: consulta a BrasilAPI até existir um snapshot ativo e passa a priorizar o Basin SQL quando a carga própria estiver pronta. Grave o token de leitura somente como segredo:

```bash
npx wrangler secret put BASIN_SQL_TOKEN
npx wrangler secret put CF_ACCOUNT_ID
```

O workflow `.github/workflows/deploy-worker.yml` aplica as migrações, sincroniza esses segredos e implanta o Worker somente quando iniciado manualmente.

## Fonte e formato

Catálogo oficial: `https://dados.gov.br/dados/conjuntos-dados/cadastro-nacional-da-pessoa-juridica---cnpj`.

Os ZIPs mensais são lidos diretamente do compartilhamento público oficial do SERPRO/Receita por WebDAV (`/public.php/dav/files/...`). A descoberta usa `PROPFIND` e os downloads usam `GET`; não há BrasilAPI nem outro intermediário.

O layout oficial usa CSV separado por `;` e codificação ISO-8859-1. A base completa não é embutida no script do Worker: ela fica no R2, que é o armazenamento apropriado para esse volume.
