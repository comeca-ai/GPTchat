# Radar Tributario v0

Triagem de carteiras de CNPJ para a reforma tributaria (LC 214/2025,
alt. LC 227/2026): recebe a carteira de um contador, cruza com o recorte
da Receita (ou consulta ao vivo) e devolve score, flags, evidencias e a
frase de trabalho por empresa — o CSV que o contador transforma em fee.

> Documentos: [historico e decisoes](historico.md) ·
> [spec da POC](spec-poc.md) · [operacao](operacao.md)

## Estado (04/10/2026)

| Componente | Valor | Estado |
|---|---|---|
| Worker | `gptchat-radar` — https://gptchat-radar.jhonata-emerick.workers.dev | no ar |
| Banco | D1 `radar-poc` (`5820842d-62c7-417c-8e6d-f750b09a75f9`) | migrado |
| Armazenamento | R2 `cnpjs`, prefixo `radar/` | pronto |
| Pipeline | workflow `radar snapshot (Receita -> recorte R2)` | aguardando secrets |
| Modo | ao-vivo (BrasilAPI, teto 200/cruzamento) | vendendo hoje |

## Arquitetura

```
carteira.csv -> Worker /api/radar/carteiras
                     |-> /cruzar -> D1 (recorte RFB) + BrasilAPI (faltantes)
                     |-> /triage -> JSON ranqueado por score
                     |-> /export -> CSV do contador

Receita (ZIPs) -> GitHub Actions (filtro em fluxo, UF+ativos+servicos)
   -> R2 radar/builds/{build_id}/ (chunks NDJSON + manifest + quality)
   -> job carga -> POST /internal/radar/load (retomavel) -> D1
```

## Flags (deterministicas, pesos em `pipeline/radar/regras_tributarias.json`)

| flag | regra | peso |
|---|---|---|
| `elegivel_127` | CNAE principal em profissao regulamentada (RASCUNHO) | 40 |
| `decisao_simples` | optante do Simples (decisao CBS/IBS ate set/2026) | 30 |
| `cnae_suspeito` | principal fora do 127, secundario dentro | 20 |
| `cnae_mudou` | evento `cnae_changed` entre competencias (job pendente) | 15 |

## Rotas

| Rota | Auth | Uso |
|---|---|---|
| `GET /api/radar/status` | `x-radar-key` | build ativo e contagens |
| `POST /api/radar/carteiras` | `x-radar-key` | CSV de CNPJs (ate 20 mil) |
| `POST /api/radar/carteiras/:id/cruzar` | `x-radar-key` | avalia e grava resultados |
| `GET /api/radar/triage/:id?offset=` | `x-radar-key` | lista ranqueada (50/pagina) |
| `GET /api/radar/triage/:id/export` | `x-radar-key` | CSV sanitizado |
| `POST /internal/radar/load` | `x-internal-key` | carga R2 -> D1 (retomavel) |

Chaves ficam como secrets do Worker (`RADAR_API_KEY`, `RADAR_INTERNAL_KEY`);
valores guardados pelo proprietario, nunca versionados.

## Limites honestos do v0

- Lista `cnaes_art127` e semente a validar com contador (a norma usa NBS).
- `cnae_mudou` depende do job de diff (nao implementado).
- Sem build publicado, o cruzamento opera ao-vivo com teto de 200
  CNPJs faltantes por rodada — dimensionado para carteira de contador.
- Ferramenta de apoio a decisao do contador; nao e parecer tributario.
