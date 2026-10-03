# POC — Radar de Expansão para fornecedores de PME

Versão 0.1 · 3 de outubro de 2026 · Especificação para implementação, ainda não implantada.

## 1. Decisão de produto

**Veredito: testar barato.** Ajudar um fornecedor de software de gestão para clínicas a escolher as contas que merecem atenção comercial, usando mudanças cadastrais verificáveis, exclusões do CRM e retorno dos vendedores. O resultado esperado é reduzir o tempo de pesquisa e aumentar reuniões qualificadas por conta trabalhada.

O piloto adota **um fornecedor de software para clínicas, cinco vendedores e o estado de São Paulo**, com filtros por município; Campinas é um exemplo de consulta. Essa é uma hipótese operacional para tornar a especificação executável, não evidência de demanda já validada. ERP genérico e contabilidade têm processos de compra diferentes: testar ambos ao mesmo tempo dificultaria interpretar o resultado. A lista de CNAEs de clínicas será acordada com o fornecedor e versionada; a palavra “clínica” não resolve essa classificação sozinha.

### Revisões da proposta original

| Proposta | Revisão para a POC |
|---|---|
| Filial nova indica expansão e compra | É uma mudança cadastral que justifica pesquisa. Não comprova inauguração física, crescimento de receita ou intenção de compra. |
| Empresas abertas nos últimos 45 dias | Filtrar a data declarada de início em relação à data da consulta e mostrar a competência disponível. Empresas muito recentes podem ainda não aparecer. |
| Entregar 50 oportunidades novas toda semana | Entregar **até** 50 contas únicas por vendedor, conforme disponibilidade. A fonte é publicada por competências; uma lista semanal não implica dados novos semanalmente. |
| O sistema aprende qual perfil vira cliente | Na POC, coletar resultados e revisar regras manualmente. Cinco vendedores e poucas semanas não justificam prometer aprendizado preditivo. |
| Histórico e feedback criam um fosso alto | Podem melhorar o produto quando há volume, qualidade, integração e direito de uso. Histórico público é replicável; poucos rótulos não constituem vantagem defensável. |
| Encontrar contatos é secundário | Medir a capacidade de chegar à empresa. Uma recomendação sem caminho de contato pode não produzir valor comercial. |

**Fatos locais:** existe código de consulta CNPJ, integração BrasilAPI, schema D1 e pipeline Receita → R2/Iceberg. A inspeção do repositório não demonstra carga nacional concluída nem implantação do código atual. Há modificações locais anteriores a este documento.

**Premissas a validar:** fornecedor disposto a pilotar; volume suficiente no recorte; dois snapshots utilizáveis; contatos empresariais com cobertura útil; mudanças cadastrais ainda chegam em tempo de influenciar a venda.

**Aposta:** combinar sinal cadastral, perfil e histórico comercial produz melhor seleção que os filtros e planilhas já usados pelo vendedor. O experimento da seção 12 decide isso.

Referências de produto: a [Common Room](https://www.commonroom.io/resources/signals/) reúne diferentes sinais para orientar ações; a [Clay](https://www.clay.com/use-cases/rep-prospecting) combina enriquecimento com fluxos comerciais. A POC adapta a relação sinal → decisão → resultado. Ela não dispõe dos sinais de navegação, uso de produto e contatos licenciados dessas plataformas. A alternativa a superar no piloto é o processo atual do cliente: CRM, listas e pesquisa manual.

## 2. Escopo e experiência

Fluxo principal: gestor configura perfil e território → importa exclusões do CRM → vendedor recebe lista → verifica evidência → registra resultado → exporta selecionados ao CRM.

### Entregas obrigatórias

1. Login de convidados, perfis de administrador e vendedor, organização identificada no servidor.
2. Perfil comercial versionado: CNAEs principais/secundários aceitos, municípios/UF, portes cadastrais, natureza jurídica, MEI e janela de eventos. Porte desconhecido tem tratamento explícito.
3. Importação CSV de contas do CRM: `cnpj`, `status`, `owner` e `external_id`; prévia, erros por linha e confirmação antes de aplicar exclusões.
4. Lista com até 50 contas, motivo verificável, filtros, atribuição de responsável e estado da abordagem. Mesmo cliente não recebe a mesma raiz para dois vendedores.
5. Página da conta com matriz/filial, atividade, município, histórico observado, fonte, competência e qualidade do contato disponível.
6. Feedback e exportação CSV compatível com o CRM escolhido. Conector nativo fica para depois da validação.
7. Visão do gestor: cobertura, rejeições, contatos localizados, reuniões, tempo de pesquisa e custo.

Campos de uma recomendação: CNPJ formatado `XX.XXX.XXX/XXXX-XX`, razão social, nome fantasia quando informado, município/UF, CNAE, porte, evento, evidências antes/depois, datas, prioridade por regra, responsável e situação no CRM.

Exemplo de apresentação, com dados fictícios: “70 pontos de prioridade. Filial recém-observada, CNAE principal compatível e município prioritário. Presente em T1, ausente em T0; raiz já registrada em T0. Início de atividade informado: DATA. Contato cadastral não verificado.” O número é prioridade de trabalho, não probabilidade de venda.

A consulta “clínicas abertas há 45 dias em Campinas e fora do CRM” usa `opened_at >= data_local_da_consulta - 45 dias`, município resolvido pela tabela oficial e exclusão por raiz de CNPJ. Mostrar os filtros aplicados e “dados da competência AAAA-MM; publicações posteriores podem conter novas empresas”. Nunca deslocar a janela de 45 dias silenciosamente para a data do snapshot.

### Fora do escopo inicial

Disparo de mensagens, robô SDR, scraping de contatos, busca de pessoas/sócios, score de crédito, previsão de faturamento, cobrança automática, conector para todos os CRMs e cobertura nacional interativa. BrasilAPI não fornece o histórico de comparação do Radar; eventual consulta pontual precisa ser exibida separadamente, com fonte e horário próprios.

## 3. Dados e recorte

Fontes: [conjunto oficial CNPJ](https://dados.gov.br/dados/conjuntos-dados/cadastro-nacional-da-pessoa-juridica---cnpj), leiaute de arquivos mapeado em `pipeline/cnpj_schema.py` e tabelas de códigos da mesma competência. O acesso ao servidor oficial deve ser novamente validado na implementação.

| Fonte | Uso e chave |
|---|---|
| Estabelecimentos | CNPJ completo, indicador matriz/filial, situação, início de atividade, CNAEs, endereço, município/UF; chave de 14 caracteres. |
| Empresas | Razão social, natureza e porte cadastral; junção pela raiz de oito caracteres. Capital social não é faturamento. |
| CNAEs e Municípios | Descrições e resolução de filtros. Não presumir que código de município da Receita seja código IBGE. |
| Simples | Opcional nesta POC; incluir nos dois snapshots somente se o perfil depender de MEI/Simples. Ausência é desconhecido, não “não optante”. |
| CRM do cliente | Exclusões, responsável e resultados, sempre privados por organização. |

Não carregar Sócios na POC. Datas inválidas e valores nulos permanecem identificados. Preservar códigos como texto e zeros à esquerda. Aceitar CNPJ numérico e alfanumérico, validar DV e manter a máscara; usar o campo oficial matriz/filial, sem inferir pelo sufixo `0001`. A [Receita descreve a transição e a relação matriz/filial](https://www.gov.br/receitafederal/pt-br/centrais-de-conteudo/publicacoes/perguntas-e-respostas/cnpj/cnpj-alfanumerico.pdf).

A base oferece campos cadastrais de telefone e e-mail, mas sua validade comercial não foi medida. Registrar separadamente: `preenchido`, `formato_valido`, `verificado_pelo_usuario`, `invalido_reportado`, fonte e data de observação. A data do snapshot não é a data de atualização do telefone. Número válido sintaticamente não comprova WhatsApp nem identifica o decisor.

**Recorte lógico pequeno não significa download pequeno.** Os arquivos particionados da Receita não devem ser tratados como arquivos por município. Para cobertura completa, percorrer todos os fragmentos necessários de Estabelecimentos/Empresas e filtrar durante a leitura. Um único ZIP serve para medir desempenho, não para prometer cobertura de São Paulo.

Comparar os dois snapshots completos mais recentes disponíveis, T0 e T1, fixados no manifesto. Se faltar T0, liberar apenas pesquisa cadastral com indicação “histórico indisponível”; a hipótese de mudanças não estará validada.

Para não confundir mudança de território/CNAE com abertura: selecionar os candidatos de T1 e recuperar suas linhas de T0 **em todos os fragmentos, sem aplicar o filtro comercial ao histórico**. Recuperar também o estado atual dos CNPJs já entregues aos vendedores, mesmo que tenham saído do recorte. As raízes correspondentes devem ser procuradas em Empresas de T0/T1. Não é necessário servir ou manter toda a base nacional no D1.

## 4. Eventos e tempo

Cada evento contém `event_id`, `cnpj`, `root_cnpj`, `event_type`, `snapshot_before`, `snapshot_after`, `before`, `after`, `declared_date`, `observed_at`, `source_refs` e `rule_version`. `declared_date` pode ser nula; `observed_at` registra nossa ingestão, não o momento em que o fato ocorreu.

| Evento | Regra determinística | Uso |
|---|---|---|
| `recent_start` | Data declarada de início dentro da janela solicitada, situação atual ativa e perfil compatível. | Sinal de início cadastral, mesmo no bootstrap; não duplicar com outro evento de maior prioridade. |
| `branch_first_observed` | CNPJ ausente de T0 completo, presente em T1, indicador filial e raiz encontrada em Empresas de T0. | Sinal principal; mostrar início declarado. Se antigo, marcar aparição tardia e não pontuar como abertura recente. |
| `cnae_changed` | Mesmo CNPJ em ambos; CNAE principal ou conjunto normalizado de secundários mudou. | Elegível para revisão quando entrou no perfil atendido. |
| `city_changed` | Mesmo CNPJ em ambos; código do município ou UF mudou. | Elegível para revisão quando entrou em território atendido. |
| `status_changed` | Mesmo CNPJ em ambos; situação mudou. | Inativação remove elegibilidade. Reativação aparece no histórico, sem bônus automático de expansão. |

Mudança de porte e Simples/MEI fica registrada como atributo quando disponível; pontuação comercial para esses eventos exige hipótese própria e fica fora do piloto principal.

Ausência em T0 só é evidência utilizável depois de validar **todos** os fragmentos necessários de T0. Ausência em T1 não significa baixa. Mudanças de texto por normalização, ordem dos CNAEs secundários e correções de ingestão não devem produzir novos eventos comerciais.

Para mudanças entre snapshots, `event_id = hash(cnpj, tipo, competências T0/T1, valores normalizados antes/depois, versão da regra)`. Para `recent_start`, usar identidade estável baseada em CNPJ e início declarado, associando novas observações ao mesmo fato; ele não vira um novo evento a cada competência. A revisão de um arquivo na mesma competência cria novo `build_id` e reconcilia os eventos; não renova sua data comercial. Mudança de versão da regra também não reinicia recência nem elimina o histórico de entrega. Uma lista semanal usa os eventos ainda elegíveis mesmo quando o snapshot não mudou.

## 5. Elegibilidade, prioridade e distribuição

Filtros obrigatórios: situação ativa, território/CNAE autorizados pelo perfil, porte permitido ou exceção explícita, ausência de bloqueio e ausência no CRM conforme política do cliente. Por padrão, cliente atual, oportunidade aberta, recusado e já trabalhado excluem a raiz inteira; expansão na base de clientes requer outro experimento.

Pontuação inicial, editável somente por nova versão do perfil:

| Componente | Pontos |
|---|---:|
| Filial recém-observada com início declarado nos últimos 90 dias | 40 |
| Início cadastral nos últimos 90 dias | 30 |
| Entrada no CNAE ou município atendido | 15 |
| Compatibilidade no CNAE principal / apenas secundário | 20 / 10 |
| Município prioritário / restante do território atendido | 10 / 0 |

Usar apenas o maior bônus de evento; máximo inicial de 70 pontos, com componentes visíveis. O limite de 90 dias é premissa do piloto, substituída por janela menor quando solicitada. Sem data declarada confiável, usar “mudança observada entre T0 e T1” e os 15 pontos de revisão, sem alegar recência de abertura. Mudanças usam a janela de observação, nunca a data da reexecução. O braço Radar exige pelo menos um evento elegível; o controle pode selecionar contas apenas pelo perfil. Contato preenchido não aumenta a pontuação.

Desempate: início declarado mais recente, data da mudança observada e CNPJ em ordem estável, com nulos por último. Guardar componentes e versão em cada item da lista. Não apresentar percentual de conversão estimado.

Uma raiz recebe um responsável por organização. Novas filiais podem ser agrupadas no mesmo cartão. Não repetir raiz já entregue nos 90 dias anteriores durante o piloto; bloqueios persistem até revisão explícita. O teto de 50 é máximo, não cota a preencher com empresas fora do perfil. Informar quando o estoque de contas acabar.

## 6. Arquitetura Cloudflare

Aplicação, dados persistentes e rotina comercial rodam na Cloudflare. Download, descompressão e transformação dos ZIPs rodam em **GitHub Actions**, conforme a restrição anterior do projeto: Workers ou Actions. Nenhum computador pessoal é necessário na operação recorrente.

| Componente | Responsabilidade na POC |
|---|---|
| Workers + Static Assets | Interface, API autenticada, filtros, explicações por template, CSV e autorização. |
| R2 Standard | ZIPs oficiais privados, manifestos, Parquet do recorte, evidências e exportações temporárias. |
| D1 | Recorte publicado, eventos, organizações, perfis, exclusões, listas, feedback e métricas. |
| Workflows + Cron Triggers | Importação retomável de pequenos lotes do R2 e geração semanal de listas por organização. |
| Cloudflare Access | Login dos convidados e proteção dos endpoints operacionais. |
| Workers Logs | Erros, duração, identificadores de execução e consumo, sem conteúdo dos contatos/CRM. |
| Workers AI, opcional | Traduzir uma frase em filtros tipados; o formulário continua funcional sem IA. |

Fluxo dos dados: Receita → Actions (leitura em fluxo, filtros e comparação) → R2 (artefatos imutáveis) → Workflow de carga → D1 (publicação validada) → Worker → vendedor → feedback no D1.

D1 terá somente o recorte necessário. Limite interno inicial: **250 mil estabelecimentos por versão e até 2 GB no banco inteiro**, incluindo índices, versões e feedback; os dois limites serão medidos, não presumidos. Ao atingir qualquer um, interromper a expansão do recorte e rever capacidade. D1 Paid limita cada banco a 10 GB e executa consultas sequencialmente; índices e consultas curtas são essenciais. [Limites D1](https://developers.cloudflare.com/d1/platform/limits/)

Workers têm 128 MB por isolate e limites de CPU; não são o ambiente escolhido para descompactar e cruzar arquivos nacionais de vários GB. Workflows preserva execução e retries, mas também herda limites de Workers. Os passos recebem referências de objetos, nunca um ZIP inteiro. [Limites Workers](https://developers.cloudflare.com/workers/platform/limits/) · [Limites Workflows](https://developers.cloudflare.com/workflows/reference/limits/)

Basin Catalog/SQL, já previstos no repositório, ficam como evolução analítica, sem bloquear esta POC. Parquet no R2 é suficiente para os artefatos de batch; consultas interativas usam D1. KV não armazena exclusões ou feedback; pode futuramente cachear dimensões públicas. Vectorize, Queues, Durable Objects e Basin Pipelines não são requisitos desta escala. A [documentação Basin](https://developers.cloudflare.com/basin/) confirma os nomes atuais de Catalog e SQL, anteriormente R2 Data Catalog/R2 SQL.

## 7. Pipeline, publicação e recuperação

Criar um fluxo próprio `radar-snapshot.yml`; não reutilizar sem revisão a promoção nacional existente. O perfil `radar` exige Estabelecimentos, Empresas e dimensões; Sócios não é requisito. Simples passa a obrigatório somente quando selecionado no perfil.

1. **Planejar:** fixar T0/T1, perfil do recorte, versão de parser/regra, commit e inventário esperado. Registrar tamanho e metadados da origem quando disponíveis. Conferir a sequência de fragmentos contra o padrão validado e a competência anterior; mudança inesperada do inventário exige revisão. A presença de um arquivo de cada tipo não comprova competência completa.
2. **Medir:** processar um ZIP completo como ensaio, cronometrar transferência e leitura, medir disco/RAM e calcular custo/tempo projetado para todos os fragmentos. Falhar antes de iniciar lote que ultrapasse a capacidade do runner.
3. **Preservar:** guardar cada ZIP completo em R2 sob prefixo próprio, com SHA-256 calculado localmente e proveniência. O hash prova identidade do arquivo recebido, não autenticidade da origem. CRC e download completo são necessários.
4. **Transformar:** usar `ZipFile.open()` ou leitor equivalente em fluxo, CSV `;`/ISO-8859-1 e batches limitados. Evitar `extract()` do CSV inteiro. Escrever Parquet incremental do recorte; usar armazenamento temporário limitado para joins e remover temporários de cada fragmento após validação. Os [runners padrão](https://docs.github.com/en/actions/reference/runners/github-hosted-runners) têm disco limitado; a soma ZIP + CSV expandido + saídas não pode ser presumida segura.
5. **Comparar:** recuperar histórico dos candidatos fora do filtro comercial, juntar Empresas/dimensões, normalizar campos e gerar os eventos da seção 4. Produzir chunks de importação, checksums e contagens esperadas.
6. **Carregar:** Actions envia somente o identificador de build ao endpoint operacional autenticado. Um Workflow lê os chunks privados do R2 e escreve D1 por binding, com parâmetros e batches pequenos; cada statement respeita o limite de parâmetros do D1. Inicialmente usar um escritor por banco.
7. **Validar:** conferir chunks, contagens reais, chaves, joins, valores e amostras. Registrar relatório de qualidade e `ready` apenas para o recorte declarado.
8. **Publicar:** primeiro concluir os objetos imutáveis no R2; depois, em transação D1, marcar build pronto e trocar `active_build_id` mediante comparação com o anterior esperado. Esse ponteiro D1 é a autoridade do Radar. Não escrever `catalog/active.json`, usado pelo produto nacional existente.
9. **Recuperar:** queda mantém o build anterior atendendo. Retomada usa `build_id + chunk_id + checksum`, com escrita idempotente; uma carga já aplicada não volta a incrementar contagem. Rollback troca somente o ponteiro para uma versão validada; feedback e bloqueios do cliente permanecem.

Chaves R2 propostas:

```text
radar/raw/{competencia}/{sha256}/{arquivo.zip}
radar/builds/{build_id}/manifest.json
radar/builds/{build_id}/curated/{tabela}/part-*.parquet
radar/builds/{build_id}/load/{tabela}/chunk-*.ndjson
radar/builds/{build_id}/quality.json
radar/tenants/{tenant_id}/imports/{import_id}.csv
radar/tenants/{tenant_id}/exports/{export_id}.csv
```

Retenção inicial: manter as duas competências usadas e o último build bom durante o piloto; revisão em 90 dias. Expirar CSV de importação/exportação em sete dias. O conjunto normalizado de exclusões permanece privado enquanto necessário ao piloto. Builds com falha expiram em sete dias se não forem necessários à investigação. Não aplicar regras de exclusão aos prefixos antigos do projeto nem ao último build utilizável.

Agendamentos a configurar na implementação: Actions procura nova competência uma vez por semana, com trava de concorrência e `workflow_dispatch` para retomada; só processa publicação nova/complementada. Cron do Worker `0 11 * * 1` inicia listas às segundas, 08h em São Paulo no fuso atual. Workflows usa chave única por organização/semana/perfil e retoma sem duplicar. Mudança de horário oficial exigirá revisão do cron UTC. Este documento não ativa agendamentos.

## 8. Modelo operacional e contratos

Modelo novo em banco D1 dedicado `radar-poc`, isolado das tabelas existentes. Chaves compartilhadas de catálogo incluem `build_id`; tabelas do cliente incluem `tenant_id`, inclusive índices, unicidade e relacionamentos.

| Tabela proposta | Conteúdo/chaves essenciais |
|---|---|
| `radar_builds`, `radar_state`, `radar_load_chunks` | Manifesto, competências, escopo, qualidade, ponteiro ativo, checkpoint e checksum por chunk. |
| `radar_establishments` | `(build_id, cnpj)`, raiz, nomes, situação, matriz/filial, datas, CNAE, município/UF, porte e contato com proveniência. |
| `radar_cnaes`, `radar_secondary_cnaes`, `radar_municipalities` | Códigos/descrições e relação normalizada; sem busca parcial em string de CNAEs. |
| `radar_events` | Build, ID determinístico, CNPJ/raiz, tipo, valores, datas, evidências e versão. |
| `radar_tenants`, `radar_members`, `radar_profiles` | Organização, usuário/role, perfil e versões imutáveis. |
| `radar_crm_accounts`, `radar_suppressions` | CNPJ/raiz, origem da importação, estado comercial e exclusões. |
| `radar_runs`, `radar_list_items`, `radar_assignments` | Semana, braço do experimento, build/perfil fixados, ranking, responsável e histórico de entrega por raiz. |
| `radar_feedback`, `radar_audit`, `radar_usage` | Eventos comerciais com autor/data, mudanças administrativas e consumo. |

Índices prioritários: `(build_id, uf, municipality_code, main_cnae, status)`, `(build_id, root_cnpj)`, `(build_id, event_type, cnpj)`, `(tenant_id, root_cnpj)` e `(tenant_id, run_id, seller_id, rank)`. Validar os planos com `EXPLAIN QUERY PLAN`; evitar varredura nacional ou de todos os tenants.

API proposta, independente das rotas antigas:

| Rota | Contrato |
|---|---|
| `GET /api/radar/status` | Build ativo, escopo, competências, data de publicação, saúde e lacunas; sem segredos. |
| `POST /api/radar/profiles` | Gestor grava nova versão de filtros e pesos após validação. |
| `POST /api/radar/crm-imports` | CSV até 5 MB/20 mil linhas; retorna prévia e rejeições, sem aplicar parcialmente. |
| `POST /api/radar/crm-imports/:id/apply` | Gestor aplica idempotentemente o conteúdo revisado. |
| `GET /api/radar/opportunities` | Filtros tipados e cursor estável, máximo 50 por página, com evidências. |
| `POST /api/radar/runs` | Inicia geração retomável, retorna `202` e `run_id`; requer chave de idempotência. |
| `GET /api/radar/runs/:id` | Estado, progresso e lista publicada da organização autorizada. |
| `POST /api/radar/items/:id/feedback` | Resultado tipado, data, motivo e responsável; idempotência. |
| `GET /api/radar/runs/:id/export` | CSV autorizado, sanitizado e com bloqueios rechecados no momento da exportação. |
| `POST /api/radar/interpret` | Opcional: frase → plano de filtros validável, sem executar SQL livre. |
| `POST /internal/radar/builds/:id/load` | Serviço de ingestão inicia Workflow com artefato autorizado; sem acesso humano comum. |

`tenant_id` deriva da identidade validada; um campo no corpo não concede acesso. Toda listagem/exportação revalida bloqueios atuais e situação da conta no build ativo, embora preserve a evidência original da recomendação. Se a importação do CRM tiver mais de sete dias, avisar “exclusões possivelmente desatualizadas”.

Feedback separa adequação (`accepted`, `wrong_profile`, `already_known`) de execução (`contact_not_found`, `contacted`, `meeting_held`, `opportunity_created`, `won`, `lost`). Uma oportunidade no CRM ainda não é uma venda; ausência de feedback não é resultado negativo. Validação/correção de contato e resultados pertencem à organização que os forneceu; não são compartilhados entre clientes nem usados para treino conjunto nesta POC.

## 9. IA e uso de tokens

A POC funciona integralmente com filtros e explicações determinísticas. Se houver tempo, Workers AI recebe apenas o pedido e o catálogo pequeno de filtros; retorna JSON com UF, município resolvível, CNAEs, janela, tipos de eventos e exclusão CRM. O servidor valida códigos/limites e mostra o plano antes de consultar.

Modelo configurável: escolher um modelo pequeno disponível na conta após testar 30 frases em português, com meta de 90% de planos corretos. Uma chamada por pedido, entrada até 2 mil tokens, saída até 500, timeout de cinco segundos, até 20 chamadas por usuário/dia. Cota é reservada em D1 antes da chamada, não em KV. O custo real depende do modelo e é registrado por uso. [Preços Workers AI](https://developers.cloudflare.com/workers-ai/platform/pricing/)

Falha ou ambiguidade retorna ao formulário. “Clínicas” precisa do dicionário aprovado; faturamento, número de funcionários e intenção de compra não estão disponíveis nessa base. Não enviar registros de contatos, CSV do CRM ou histórico completo ao modelo; não fazer uma chamada por CNPJ. Sem embeddings ou fine-tuning nesta etapa.

## 10. Acesso e tratamento dos dados

Usar aplicação Access com lista de convidados; validar identidade, assinatura, emissor, audiência e validade do token antes de mapear usuário/organização. Proteger também URLs alternativas de preview e `workers.dev`, ou desativá-las. A [documentação de validação Access](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/) orienta a integração.

R2 sem acesso público. Download de CSV passa pelo Worker autenticado. Escritas exigem proteção contra requisições de outra origem; SQL parametrizado, escape de HTML e neutralização de células CSV interpretáveis como fórmula. Testar que um usuário não lê IDs, listas, feedback nem exportações de outra organização.

Segredos em Workers Secrets e GitHub Environments, com acesso mínimo ao bucket/prefixo aplicável e endpoints operacionais. Jobs com credenciais só executam código confiável da branch autorizada, nunca conteúdo de PR de fork. O repo pode ser público; dados de clientes, dumps, credenciais e CSVs nunca vão para Git, logs ou artefatos públicos do Actions.

Minimizar dados pessoais; não incluir QSA/CPF nem contatos pessoais obtidos por inferência. Contato cadastral exige finalidade documentada, acesso restrito, canal de correção/exclusão e supressão respeitada nas próximas listas. Definir responsabilidades entre fornecedor e cliente antes de usar contatos reais. Dados públicos não eliminam essa avaliação: a [orientação da ANPD](https://www.gov.br/anpd/pt-br/assuntos/noticias/anpd-lanca-guia-orientativo-sobre-legitimo-interesse) descreve finalidade, necessidade e balanceamento. Isso é requisito de desenho da POC, não conclusão jurídica de que qualquer prospecção está autorizada.

## 11. Custos e controles

Valores de referência consultados em 03/10/2026, em USD, sem impostos, câmbio, desenvolvimento ou enriquecimento pago. As franquias são compartilhadas pela conta: consumo de outros projetos pode reduzir o saldo disponível. Créditos promocionais não entram na conta de viabilidade; elegibilidade e vencimento devem ser conferidos antes de executar.

| Item | Premissa de dimensionamento e custo |
|---|---|
| Workers Paid | US$5/mês de plano; inclui 10 milhões de requests e 30 milhões de ms de CPU. Pode já estar contratado na conta. [Tabela](https://developers.cloudflare.com/workers/platform/pricing/) |
| R2 Standard | Cenário de 100–250 GB-mês, não medição da base: `(GB-mês − 10) × US$0,015` = US$1,35–3,60 de armazenamento, se franquia disponível. Operações são cobradas separadamente. [Tabela](https://developers.cloudflare.com/r2/pricing/) |
| D1 | Projeto abaixo de 2 GB; Paid inclui 5 GB, 25 bilhões de linhas lidas/mês e 50 milhões escritas/mês. Índices também aumentam escritas. Uso real será medido. [Tabela](https://developers.cloudflare.com/d1/platform/pricing/) |
| Workflows | Estimar menos de 20 mil passos e 100 MB de estado; Paid inclui 500 mil passos/mês e 1 GB-mês. CPU/requests compartilham Workers. [Tabela](https://developers.cloudflare.com/workflows/reference/pricing/) |
| Access e logs | Selecionar plano de piloto e limites de logs compatíveis com a conta; confirmar disponibilidade e custo no provisionamento. Não assumir novas licenças gratuitas sem essa conferência. |
| Workers AI | Desativado por padrão; reserva opcional de até US$5 no mês, com cotas por modelo/usuário. |
| GitHub Actions | Runners padrão de repositórios públicos são gratuitos nas condições aplicáveis; privados/larger runners e outros consumos podem cobrar à parte. Revalidar quota e política antes da carga. [Cobrança](https://docs.github.com/en/actions/concepts/billing-and-usage) |

**Envelope proposto: US$10–25/mês de Cloudflare para o piloto**, condicionado às premissas acima e ao plano Access/logs, com alerta operacional em US$15 e revisão ao projetar mais de US$25. Não é orçamento medido nem limite rígido do provedor. Ingestão inicial tem tempo e possível custo de runner ainda desconhecidos; o ensaio de um fragmento produz a projeção antes da carga completa.

Controles da aplicação: limites de registros/bytes, concorrência de ingestão de dois downloads e um escritor D1, timeout/retries limitados, cotas de IA, expiração de artefatos e leitura de métricas por build. Ao exceder orçamento estimado, não iniciar novos jobs/IA; armazenamento já existente continua cobrando. Limites locais não garantem teto absoluto da fatura.

Se Basin SQL for adotado depois, adicionar custo de dados lidos, operações R2 e catálogo: a [tabela atual](https://developers.cloudflare.com/basin-sql/platform/pricing/) informa US$0,0025/GB lido após 10 GB mensais. Esse valor não está incluído como dependência do piloto.

## 12. Experimento e métricas

Quatro semanas a partir do início autorizado e disponibilidade do fornecedor. Semana 1 mede dados/custo, fecha o perfil e coleta o processo atual; semana 2 entrega um lote utilizável; semanas 3–4 concentram o teste comercial. Se a primeira lista chegar tarde, não declarar validado um piloto sem pelo menos dez dias úteis de observação.

Em cada lista de até 50 contas por vendedor, distribuir até 25 selecionadas por sinais e até 25 pelo método habitual do cliente, documentado e congelado antes do teste. Usar o mesmo território, perfil e fontes de contato. Reservar grupos disjuntos de raízes para os dois métodos, mantendo vendedor e período comparáveis; nenhuma raiz entra nos dois braços. Se não houver volume, reduzir ambos e registrar a limitação.

Isso compara métodos de seleção; não prova causalidade estatística com amostra pequena. Revisão de evidências e observação de uso complementam as taxas. Não esperar obrigatoriamente vendas fechadas dentro de quatro semanas se o ciclo do cliente for maior.

| Métrica | Definição e meta inicial de decisão, a validar |
|---|---|
| Qualidade de evento | Auditoria humana de 100 eventos estratificados, ou todos se houver menos: ≥95% corretos contra a fonte. |
| Cobertura de avaliação | ≥80% das contas entregues com adequação avaliada, mostrando números absolutos por braço. |
| Aceitação | Contas com `accepted` / contas avaliadas: ≥60%; reportar também aceitas/entregues. |
| Caminho de contato | Empresa com canal empresarial utilizável confirmado pelo vendedor / contas investigadas: meta exploratória ≥50%, separada da mera presença cadastral. |
| Tempo de pesquisa | Mediana de minutos ativos por conta, medidos por amostra de tarefa e não por aba aberta: redução de ≥30% frente ao método habitual. |
| Reuniões | Reuniões qualificadas realizadas / contas entregues; reportar também / contas efetivamente abordadas. Meta exploratória de 1,5× o controle, sempre com numeradores/denominadores e janela igual. |
| Disposição a pagar | Um gestor aceita proposta de piloto pago em faixa definida antes de mostrar resultados. Hipótese de teste: R$500–1.500/mês por equipe; não é preço validado nem benchmark. |

Se o controle tiver zero reuniões, não calcular “aumento infinito”; avaliar números absolutos e ampliar observação. Registrar motivo de rejeição, cadência efetivamente usada e dias de exposição para detectar viés. “Não localizado” é falha de acionabilidade, não de adequação do perfil.

Decisão ao final: avançar se qualidade, utilidade econômica e compromisso de pagamento forem convincentes. Ajustar recorte se houver aderência com pouco volume. Reposicionar se a defasagem tornar os sinais inúteis ou o contato consumir o ganho de tempo. Não financiar enriquecimento nacional para compensar uma hipótese comercial ainda sem evidência.

## 13. Critérios técnicos de aceite

- Manifesto completo do recorte, hashes, contagens e unicidade de chaves aprovados; joins de Empresas/dimensões ≥99,5% nos candidatos, com exceções documentadas. Erros críticos bloqueiam publicação; limiares são metas da POC.
- Fixtures para filial recente, aparição tardia, alteração de CNAE/município, reativação, inativação, ausência em arquivo incompleto, CNPJ alfanumérico, nulos e troca da ordem de CNAEs secundários.
- Reexecutar o mesmo build/chunk não duplica registros, eventos ou listas; correção da mesma competência não cria falsa novidade. Testar interrupção antes/depois da promoção e restauração do build anterior.
- Feedback e bloqueios são imediatamente considerados em próxima consulta/exportação, inclusive após rollback do catálogo. Nenhum acesso entre organizações nos testes de API, cache e CSV.
- Lista de 50 itens: p95 de API ≤1 segundo com cinco usuários concorrentes e o recorte-alvo; a interface não faz scans no R2/Basin. Exportação de 50 contas ≤5 segundos, salvo indisponibilidade externa documentada.
- Geração semanal das listas dos cinco vendedores ≤5 minutos, retomável. Falha de um lote não publica lista parcial como completa.
- IA desligada, sem saldo ou indisponível não impede pesquisa, explicação ou exportação.
- Custo/consumo por execução visível; teste de quota impede nova IA/job sem apagar dados. Logs não contêm contatos nem linhas de CRM.

## 14. Plano de implementação no repositório

| Etapa | Trabalho verificável | Saída |
|---|---|---|
| Semana 1 — dados e comprador | Fechar fornecedor/perfil; medir fragmento completo; inventariar T0/T1; definir volume, contato e orçamento. | Relatório de viabilidade e baseline. |
| Semana 2 — primeira entrega | Transformação em fluxo, diffs, D1 de staging/publicação, Access, filtros e lista com evidências. | Primeiro lote auditado por vendedores. |
| Semana 3 — operação | Importação de exclusões, atribuição, feedback, exportação e listas retomáveis; iniciar/continuar comparação comercial. | Uso real instrumentado. |
| Semana 4 — decisão | Corrigir falhas de qualidade, medir tempo/reuniões/custo e apresentar proposta paga. IA apenas se não atrasar o teste. | Relatório continuar/ajustar/encerrar. |

Arquivos futuros sugeridos: `pipeline/radar/` para recorte/diffs/qualidade, `.github/workflows/radar-snapshot.yml`, `migrations-radar/`, `src/radar/` e `wrangler.radar.jsonc`. Criar Worker/banco de piloto separados e prefixo R2 `radar/`, preservando o serviço existente. Mudanças de produção e ativação de carga continuam dependentes da retomada solicitada pelo proprietário; esta entrega é a especificação.

Lacunas observadas no código atual que a implementação deverá resolver:

- `discover_rfb.py` exige tipos de tabelas, mas isso sozinho não prova presença de todos os fragmentos; há exigência de Sócios incompatível com o recorte do Radar.
- `ingest_zip.py` expande CSV para disco e usa identidade de URL para retomada. A POC precisa de leitura em fluxo, identidade do conteúdo, limites de recursos e tratamento de republicação.
- `finalize_snapshot.py` confere marcadores/tabelas, mas não executa todos os testes de qualidade aqui exigidos; uma retomada de append já confirmado pode registrar zero linhas no marcador.
- O schema D1 atual não guarda versões completas, organizações, eventos, listas nem feedback; não deve receber a carga nacional para viabilizar o Radar.
- A consulta híbrida/BrasilAPI não demonstra mudanças entre competências e não substitui o histórico oficial.

Primeiro marco implementável: selecionar o fornecedor piloto e executar, quando retomada a carga, o ensaio de um fragmento completo com relatório de tempo, disco, cobertura dos campos e custo projetado. A decisão de escalar o processamento depende desse relatório e da disponibilidade real do recorte, não do saldo promocional.
