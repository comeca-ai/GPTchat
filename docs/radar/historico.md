# Radar Tributario — historico e decisoes

Documento de memoria do projeto: como chegamos ate aqui, o que foi
descartado e por que. Atualizado em 04/10/2026.

## 1. Origem: a pergunta sobre a TypeSafe AI (Jev)

A conversa comecou com a pergunta: "o que daria para criar rapido e com
receita usando o Jev, o modelo 'System One' da TypeSafe AI?" — um modelo
que responde perguntas tipadas (Choice, Score, Noul) com decisao
estruturada e confianca calibrada, sem geracao de texto.

A analise (metodo: onde mora o valor defensavel) concluiu:

- **Modelo e aluguel.** Construir feature em cima da API de terceiros —
  ainda mais com preco de lancamento possivelmente subsidiado, waitlist,
  sem regiao fora dos EUA e copycats ja anunciados — e alugar o fosso do
  vizinho.
- **O valor defensavel esta em:** dado proprietario, ontologia (o schema
  de decisao do vertical), workflow implantado e distribuicao.
- **Motor agnostico desde o dia 1:** o produto nao pode casar com nenhuma
  API de modelo; o motor de decisao troca, o produto fica.

## 2. Caminhos avaliados e descartados

| Ideia | Veredito | Motivo |
|---|---|---|
| Router de LLM para clientes com agentes em producao | Descartado | No Brasil, poucas empresas tem conta de inferencia grande o bastante para o corte pagar o fee; mercado horizontal que os gateways comoditizam em meses. |
| B2C puro: "tenho direito a esse reembolso/beneficio?" | Parcialmente descartado | Dor real e pergunta perfeita para o motor, mas quem pergunta (pessoa fisica) e quem menos paga; CAC de consumidor + fosso fino (a regra e publica). Sobrevive como success fee estilo AirHelp ou como laboratorio de demanda, nao como produto principal. |
| B2B ticket alto para grandes empresas (reforma tributaria) | Descartado | Ja bem atendido por Big Four e consultorias. |
| **Triagem regulataria/decisoria para PME via contador** | **Escolhido** | Vazio real: PME e o contador dela, com prazo legal no pescoco e nenhuma ferramenta decisoria por CNPJ. |

## 3. A tese escolhida: Raio-X de Enquadramento (reforma tributaria)

Contexto: LC 214/2025 (alterada pela LC 227/2026). Fatos que sustentam
a tese:

- Desde 03/08/2026, NF-e sem campos de IBS/CBS e rejeitada: erro de
  CNAE/enquadramento trava o faturamento.
- Reducoes de aliquota de 30% (art. 127, profissoes regulamentadas), 60%
  e zero por categoria: CNAE errado virou dinheiro vivo.
- Empresas do Simples precisam decidir ate set/2026 se recolhem CBS/IBS
  dentro ou fora do DAS, valendo de 01/01/2027 — e quem errar fica mais
  caro para o cliente PJ (guerra de creditos) e perde contrato sem saber.
- O contador de PME tem ~200 CNPJs na carteira e nenhuma capacidade de
  revisar um a um.

**Produto:** triagem da carteira inteira do contador por CNPJ, com flags
deterministicas, score, evidencia e frase de trabalho. O entregavel e um
CSV que o contador transforma em fee (R$ 300-800 por re-enquadramento).

**Modelo de receita:** setup por carteira + assinatura de monitoramento
(a norma muda ate 2033; cada mudanca e evento de receita, nao de custo).
Canal = o contador, nunca venda direta a PME (CAC).

## 4. Fusao com a POC "Radar de Expansao"

A POC original (ver `spec-poc.md`) detectava mudancas cadastrais na base
CNPJ (filial nova, `cnae_changed`, mudanca de municipio) para orientar
prospeccao de fornecedores de PME. A leitura conjunta mostrou que e o
mesmo produto olhando para dois compradores:

- O evento `cnae_changed`, em 2026, deixa de ser "sinal de expansao" e
  vira "alguem esta pagando imposto errado agora" — lead quente para
  contador/consultoria tributaria.
- O estado que o motor de decisao precisa (CNAEs, Simples, porte,
  municipio) e exatamente o que o pipeline do Radar ja ingere.
- A camada tributaria resolve o ponto mais fraco da POC: o fosso.
  Historico publico e replicavel; a ontologia CNAE x NBS x LC 214
  calibrada pelo feedback dos contadores, nao.

Decisao: rodar a POC como especificada (nao contaminar o experimento),
gravar contexto tributario nos eventos desde o dia 1 (custo zero) e
validar o comprador contabil em paralelo com teste manual.

## 5. Decisoes de implementacao do v0

1. **Sem Worker processando base:** Workers tem 128 MB e limite de CPU.
   Pipeline = GitHub Actions (filtro em fluxo, nunca descompacta CSV
   inteiro) -> R2 (artefatos imutaveis) -> Worker le chunks e grava D1
   (carga retomavel, idempotente, via `/internal/radar/load`).
2. **Banco separado:** D1 `radar-poc` e Worker `gptchat-radar`
   dedicados; o servico `gptchat-cnpj` existente nao foi tocado.
3. **Flags deterministicas, zero IA no v0:** elegivel_127 (40),
   decisao_simples (30), cnae_suspeito (20), cnae_mudou (15). A lista de
   CNAEs do art. 127 e RASCUNHO a validar com contador — a norma
   referencia NBS, o mapeamento CNAE e aproximacao operacional.
4. **Modo ao-vivo (BrasilAPI):** adicionado depois que o sandbox e os
   runners mostraram restricoes de acesso a Receita. O `/cruzar` consulta
   ao vivo ate 200 CNPJs faltantes por rodada — o produto vende HOJE para
   carteiras de contador, sem esperar a carga nacional.
5. **Responsabilidade:** a ferramenta e apoio a decisao do contador; ele
   assina o dossiê. Isso e desenho de produto e de canal, nao detalhe
   juridico.

## 6. Licoes de operacao (o que aconteceu de verdade)

- O servidor da Receita (WebDAV e dadosabertos.rfb.gov.br) recusa
  conexao de redes fora do Brasil/datacenters: pipeline nacional so e
  viavel via GitHub Actions ou maquina no Brasil.
- Token Cloudflare inicial so tinha permissao de Workers: D1 exigiu
  token novo com D1:Edit. Valores de API token nao podem ser
  reconsultados no painel — guardar na criacao.
- PAT do GitHub com escopo de conteudo nao grava secrets de Actions:
  os 6 secrets do pipeline foram deixados como acao manual do dono.
- O CNPJ de exemplo do README (`53.486.573/0001-43`) tem DV invalido —
  virou caso de teste de rejeicao.

## 7. Plano de receita (o que paga o projeto)

Sequencia acordada: **venda manual -> receita -> plataforma -> assinatura.**

1. Semana 1: ligar para 3 contadores; vender a triagem da carteira por
   R$ 3.000-5.000 por 100 CNPJs (fee do contador: R$ 300-800/CNPJ).
2. Entregar via modo ao-vivo (3 comandos curl) ou manual assistido.
3. Medir hit rate (% da carteira com dinheiro/risco escondido). Aposta:
   30-50%.
4. Com 2-3 pagantes: ligar a carga nacional, white-label para o
   escritorio e assinatura de monitoramento regulatorio.

## 8. Pendencias conhecidas

- [ ] Adicionar 6 secrets no repo (R2_ENDPOINT, R2_ACCESS_KEY_ID,
      R2_SECRET_ACCESS_KEY, R2_BUCKET, RADAR_INTERNAL_KEY,
      RADAR_WORKER_URL) e rodar o workflow `radar snapshot`
      (ensaio=true -> medir -> ensaio=false).
- [ ] Diff entre competencias (`cnae_changed`) — tabela pronta, job nao
      implementado no v0.
- [ ] Validar `regras_tributarias.json` (lista art. 127) com contador.
- [ ] Migrar auth de chave compartilhada para Cloudflare Access ao sair
      do piloto (spec secao 10).
- [ ] Rotacionar tokens expostos em chat (GitHub PAT e Cloudflare).
- [ ] Se o recorte SP/servicos estourar o limite da spec (250 mil
      estabelecimentos), restringir divisoes CNAE ou municipios.
