# Radar Tributario v0 — operacao

Worker separado (`gptchat-radar`) que recebe a carteira de CNPJs de um
contador, cruza com o recorte da Receita publicado no D1 e devolve a
lista triada com flags tributarias da reforma. Nao toca no servico
`gptchat-cnpj` existente.

## Arquitetura do v0

```
Receita (ZIPs) -> GitHub Actions (filtro em fluxo) -> R2 radar/builds/
  -> POST /internal/radar/load (Worker le chunks e grava no D1)
  -> POST /api/radar/carteiras (CSV do contador)
  -> POST /api/radar/carteiras/:id/cruzar
  -> GET  /api/radar/triage/:id e /export
```

## Provisionamento (uma vez)

```bash
npx wrangler login
npx wrangler d1 create radar-poc
# copiar o database_id para wrangler.radar.jsonc (campo PREENCHER_APOS_CRIAR)
npx wrangler d1 migrations apply radar-poc -c wrangler.radar.jsonc --remote
npx wrangler secret put RADAR_API_KEY -c wrangler.radar.jsonc       # chave dos contadores
npx wrangler secret put RADAR_INTERNAL_KEY -c wrangler.radar.jsonc  # chave da carga
npx wrangler deploy -c wrangler.radar.jsonc
```

## Dados — IMPORTANTE: Receita bloqueia datacenters

O servidor oficial (WebDAV e dadosabertos.rfb.gov.br) recusa conexoes de
IP fora do Brasil/datacenter — confirmado em 03/10/2026 com falha do
discover tanto no sandbox quanto em runner do GitHub Actions
("Remote end closed connection without response"). O workflow
`radar snapshot` so funcionara em self-hosted runner no Brasil.
**Caminho oficial do v0: execucao local** com
`pipeline/radar/rodar_local.sh` (ensaio -> completo -> carga).

### Execucao local (Mac/Linux, IP brasileiro)

```bash
git clone -b radar-v0 https://github.com/comeca-ai/GPTchat.git && cd GPTchat
export R2_ENDPOINT="https://<account>.r2.cloudflarestorage.com"
export R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=... R2_BUCKET=cnpjs
export RADAR_INTERNAL_KEY=... RADAR_WORKER_URL="https://gptchat-radar.<sub>.workers.dev"
bash pipeline/radar/rodar_local.sh ensaio     # mede 1 fragmento
bash pipeline/radar/rodar_local.sh completo   # extrai o recorte todo
bash pipeline/radar/rodar_local.sh carga      # carrega o D1
```

### Dados (GitHub Actions — legado, requer runner no Brasil)

Segredos necessarios no repositorio (mesmos do pipeline principal):
`R2_ENDPOINT`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`.

1. Rodar `radar snapshot (Receita -> recorte R2)` com `ensaio=true`.
   O artefato `quality-ensaio.json` no R2 traz tempo, linhas e projecao.
   So escalar se a projecao couber no envelope (spec: US$10-25/mes).
2. Rodar de novo com `ensaio=false` (carga completa do recorte).
3. Carregar no D1 (repetir ate `done: true`):

```bash
curl -X POST https://gptchat-radar.<sub>.workers.dev/internal/radar/load \
  -H "x-internal-key: $RADAR_INTERNAL_KEY" \
  -H "content-type: application/json" \
  -d "{\"build_id\":\"AAAA-MM-SP-xxxxxxxx\",\"offset\":0,\"limit\":5}"
```

## Uso (contador)

```bash
# 1. upload da carteira (CSV com uma coluna de CNPJ)
curl -X POST .../api/radar/carteiras -H "x-radar-key: $K" \
  -H "content-type: text/csv" --data-binary @carteira.csv
# -> {"carteira_id": "..."}

# 2. cruzar
curl -X POST .../api/radar/carteiras/<id>/cruzar -H "x-radar-key: $K"

# 3. triagem e exportacao
curl .../api/radar/triage/<id> -H "x-radar-key: $K"
curl .../api/radar/triage/<id>/export -H "x-radar-key: $K" -o triage.csv
```

## Flags do v0 (deterministicas, sem IA)

| flag | regra | peso |
|---|---|---|
| `elegivel_127` | CNAE principal na lista de profissoes regulamentadas (RASCUNHO) | 40 |
| `decisao_simples` | optante do Simples com CNAE de servico (decisao CBS/IBS ate set/2026) | 30 |
| `cnae_suspeito` | principal fora do 127, secundario dentro: revisar enquadramento | 20 |
| `cnae_mudou` | evento `cnae_changed` entre competencias | 15 |

## Limitacoes honestas do v0

- `cnae_mudou` depende de segunda competencia; o job de diff nao esta no
  v0 (tabela `radar_eventos` ja existe).
- A lista `cnaes_art127` e semente RASCUNHO: a norma referencia NBS, o
  mapeamento CNAE e aproximacao operacional. Validar com contador antes
  de usar em decisao de cliente (`regras_tributarias.json`).
- Recorte SP/servicos pode superar o limite interno da spec (250 mil
  estabelecimentos): o ensaio mede antes; se estourar, restringir
  divisoes ou municipios no arquivo de regras.
- Auth por chave compartilhada; migrar para Cloudflare Access ao sair do
  piloto (spec secao 10). Dados de contato cadastral ficam fora do v0.
- Contador assina o dossiê: a ferramenta e apoio a decisao, nao parecer
  tributario.
