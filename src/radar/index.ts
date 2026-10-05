/** Radar v0 — Worker separado do produto CNPJ existente.
 *
 * Rotas:
 *   GET  /api/radar/status
 *   POST /api/radar/carteiras            (CSV de CNPJs, texto puro)
 *   POST /api/radar/carteiras/:id/cruzar
 *   GET  /api/radar/triage/:id?offset=
 *   GET  /api/radar/triage/:id/export
 *   POST /internal/radar/load            {build_id, offset?, limit?}
 *
 * Auth v0: X-Radar-Key (rotas /api) e X-Internal-Key (/internal).
 * Substituir por Cloudflare Access quando sair do piloto (spec secao 10).
 */

import { normalizarCnpj, dvValido, raizDe, formatarCnpj } from "./cnpj.ts";
import { avaliar, type Estabelecimento } from "./flags.ts";

export interface Env {
  RADAR_DB: D1Database;
  SNAPSHOTS: R2Bucket;
  RADAR_API_KEY: string;
  RADAR_INTERNAL_KEY: string;
}

const JSONH = { "content-type": "application/json; charset=utf-8" };

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), { status, headers: JSONH });
}

function autorizado(req: Request, env: Env, escopo: "api" | "internal"): boolean {
  const esperado = escopo === "api" ? env.RADAR_API_KEY : env.RADAR_INTERNAL_KEY;
  if (!esperado) return false;
  const chave = req.headers.get(escopo === "api" ? "x-radar-key" : "x-internal-key");
  return !!chave && chave === esperado;
}

async function buildAtivo(env: Env) {
  return env.RADAR_DB.prepare(
    `SELECT b.* FROM radar_state s JOIN radar_builds b ON b.build_id = s.active_build_id
     WHERE s.id = 1 AND b.status = 'ready'`
  ).first();
}

/* ---------- carga interna: R2 -> D1, retomavel e idempotente ---------- */

const COLS = 15; // colunas de radar_estabelecimentos
const ROWS_PER_STMT = 6; // 6 x 15 = 90 <= limite de 100 parametros do D1

async function carregar(env: Env, req: Request): Promise<Response> {
  const corpo = (await req.json().catch(() => ({}))) as {
    build_id?: string; offset?: number; limit?: number;
  };
  if (!corpo.build_id) return json({ erro: "build_id obrigatorio" }, 400);
  const buildId = corpo.build_id;
  const offset = Math.max(0, corpo.offset ?? 0);
  const limit = Math.min(Math.max(1, corpo.limit ?? 5), 20);

  const obj = await env.SNAPSHOTS.get(`radar/builds/${buildId}/manifest.json`);
  if (!obj) return json({ erro: `manifest nao encontrado para ${buildId}` }, 404);
  const manifest = (await obj.json()) as {
    competencia: string; uf: string; regras_version: string;
    chunks: string[]; total_registros: number;
  };

  await env.RADAR_DB.prepare(
    `INSERT OR IGNORE INTO radar_builds
       (build_id, competencia, uf, regras_version, status, total_chunks, total_registros)
     VALUES (?,?,?,?, 'loading', ?, ?)`
  ).bind(buildId, manifest.competencia, manifest.uf, manifest.regras_version,
         manifest.chunks.length, manifest.total_registros).run();

  const fatia = manifest.chunks.slice(offset, offset + limit);
  let inseridos = 0;
  for (const key of fatia) {
    const chunk = await env.SNAPSHOTS.get(key);
    if (!chunk) return json({ erro: `chunk ausente: ${key}` }, 502);
    const linhas = (await chunk.text()).split("\n").filter(Boolean);
    const rows = linhas.map((l) => JSON.parse(l) as Record<string, unknown>);
    for (let i = 0; i < rows.length; i += ROWS_PER_STMT * 100) {
      const grupo = rows.slice(i, i + ROWS_PER_STMT * 100);
      const stmts: D1PreparedStatement[] = [];
      for (let j = 0; j < grupo.length; j += ROWS_PER_STMT) {
        const parte = grupo.slice(j, j + ROWS_PER_STMT);
        const marca = parte.map(() => "(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").join(",");
        const flat = parte.flatMap((r) => [
          buildId, r.cnpj, r.cnpj_raiz, r.razao_social ?? "", r.nome_fantasia,
          r.matriz_filial ?? "1", r.cnae_principal, r.cnaes_secundarios,
          r.uf, r.municipio_codigo, r.porte, r.natureza_juridica,
          r.data_inicio, r.simples, r.mei,
        ]);
        stmts.push(env.RADAR_DB.prepare(
          `INSERT OR IGNORE INTO radar_estabelecimentos
           (build_id, cnpj, cnpj_raiz, razao_social, nome_fantasia, matriz_filial,
            cnae_principal, cnaes_secundarios, uf, municipio_codigo, porte,
            natureza_juridica, data_inicio, simples, mei) VALUES ${marca}`
        ).bind(...(flat as (string | null)[])));
      }
      await env.RADAR_DB.batch(stmts);
    }
    inseridos += rows.length;
    await env.RADAR_DB.prepare(
      `UPDATE radar_builds SET loaded_chunks = MIN(loaded_chunks + 1, total_chunks)
       WHERE build_id = ?`
    ).bind(buildId).run();
  }

  const build = await env.RADAR_DB.prepare(
    `SELECT loaded_chunks, total_chunks FROM radar_builds WHERE build_id = ?`
  ).bind(buildId).first() as { loaded_chunks: number; total_chunks: number } | null;

  const done = !!build && build.loaded_chunks >= build.total_chunks;
  if (done) {
    await env.RADAR_DB.batch([
      env.RADAR_DB.prepare(`UPDATE radar_builds SET status = 'ready' WHERE build_id = ?`).bind(buildId),
      env.RADAR_DB.prepare(
        `INSERT INTO radar_state (id, active_build_id) VALUES (1, ?)
         ON CONFLICT(id) DO UPDATE SET active_build_id = excluded.active_build_id`
      ).bind(buildId),
    ]);
  }
  return json({ build_id: buildId, processados: fatia.length, inseridos,
                loaded_chunks: build?.loaded_chunks ?? 0,
                total_chunks: manifest.chunks.length, done,
                proximo_offset: done ? null : offset + fatia.length });
}

/* ---------- carteira: upload, cruzamento, triagem ---------- */

async function novaCarteira(env: Env, req: Request): Promise<Response> {
  const texto = await req.text();
  if (!texto.trim()) return json({ erro: "corpo CSV vazio" }, 400);
  if (texto.length > 5 * 1024 * 1024) return json({ erro: "CSV acima de 5 MB" }, 413);

  const vistos = new Set<string>();
  const validos: string[] = [];
  let invalidos = 0;
  for (const [i, linha] of texto.split(/\r?\n/).entries()) {
    const celula = linha.split(/[;,]/)[0].trim();
    if (!celula) continue;
    if (i === 0 && /cnpj/i.test(celula)) continue; // cabecalho
    const cnpj = normalizarCnpj(celula);
    if (!cnpj || !dvValido(cnpj)) { if (celula) invalidos++; continue; }
    if (!vistos.has(cnpj)) { vistos.add(cnpj); validos.push(cnpj); }
  }
  if (validos.length === 0) return json({ erro: "nenhum CNPJ valido", invalidos }, 422);
  if (validos.length > 20_000) return json({ erro: "limite de 20 mil CNPJs por carteira" }, 413);

  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(validos.join("\n")));
  const carteiraId = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 24);

  await env.RADAR_DB.prepare(
    `INSERT OR IGNORE INTO radar_carteiras (carteira_id, tenant, total_cnpjs, invalidos)
     VALUES (?, 'default', ?, ?)`
  ).bind(carteiraId, validos.length, invalidos).run();

  const stmts: D1PreparedStatement[] = [];
  for (let i = 0; i < validos.length; i += 33) { // 33 x 3 = 99 <= 100 params
    const parte = validos.slice(i, i + 33);
    const marca = parte.map(() => "(?,?,?)").join(",");
    stmts.push(env.RADAR_DB.prepare(
      `INSERT OR IGNORE INTO radar_carteira_cnpjs (carteira_id, cnpj, cnpj_raiz) VALUES ${marca}`
    ).bind(...parte.flatMap((c) => [carteiraId, c, raizDe(c)])));
  }
  for (let i = 0; i < stmts.length; i += 100) {
    await env.RADAR_DB.batch(stmts.slice(i, i + 100));
  }
  return json({ carteira_id: carteiraId, total: validos.length, invalidos }, 201);
}

/* ---------- fallback ao vivo: BrasilAPI para CNPJs fora do recorte ---------- */

const FALLBACK_LIMITE = 200; // teto de consultas ao vivo por cruzamento
const FALLBACK_CONCORRENCIA = 5;

interface BrasilApiCnpj {
  cnpj?: string; razao_social?: string; nome_fantasia?: string | null;
  cnae_fiscal?: number; cnaes_secundarios?: { codigo: number }[];
  uf?: string; codigo_municipio?: number; porte?: string | null;
  identificador_matriz_filial?: number; data_inicio_atividade?: string | null;
  opcao_pelo_simples?: boolean | null; opcao_pelo_mei?: boolean | null;
}

async function buscarBrasilApi(cnpj: string): Promise<Estabelecimento | null> {
  try {
    const r = await fetch(`https://brasilapi.com.br/api/cnpj/v1/${cnpj}`, {
      headers: { "user-agent": "gptchat-radar/0.1" }, signal: AbortSignal.timeout(5_000),
    });
    if (!r.ok) return null;
    const d = (await r.json()) as BrasilApiCnpj;
    const cnaes = (d.cnaes_secundarios ?? []).map((c) => String(c.codigo).padStart(7, "0"));
    return {
      cnpj,
      cnpj_raiz: cnpj.slice(0, 8),
      razao_social: d.razao_social ?? "",
      nome_fantasia: d.nome_fantasia ?? null,
      matriz_filial: String(d.identificador_matriz_filial ?? 1),
      cnae_principal: d.cnae_fiscal ? String(d.cnae_fiscal).padStart(7, "0") : "",
      cnaes_secundarios: cnaes.length ? cnaes.join(",") : null,
      uf: d.uf ?? "",
      municipio_codigo: d.codigo_municipio ? String(d.codigo_municipio) : null,
      porte: d.porte ?? null,
      simples: d.opcao_pelo_simples == null ? null : d.opcao_pelo_simples ? "S" : "N",
      mei: d.opcao_pelo_mei == null ? null : d.opcao_pelo_mei ? "S" : "N",
      data_inicio: d.data_inicio_atividade ? d.data_inicio_atividade.replaceAll("-", "") : null,
    };
  } catch {
    return null;
  }
}

async function cruzar(env: Env, carteiraId: string): Promise<Response> {
  const buildAtivoRow = await buildAtivo(env) as { build_id: string; competencia: string } | null;
  // sem build publicado, opera em modo ao-vivo: tudo via BrasilAPI (teto FALLBACK_LIMITE)
  const build = buildAtivoRow ?? { build_id: "ao-vivo", competencia: "ao-vivo" };

  const cart = await env.RADAR_DB.prepare(
    `SELECT cnpj, cnpj_raiz FROM radar_carteira_cnpjs WHERE carteira_id = ?`
  ).bind(carteiraId).all();
  const itens = (cart.results ?? []) as { cnpj: string; cnpj_raiz: string }[];
  if (itens.length === 0) return json({ erro: "carteira nao encontrada ou vazia" }, 404);

  const porCnpj = new Map<string, Estabelecimento>();
  const eventosPorRaiz = new Map<string, string[]>();

  for (let i = 0; i < itens.length; i += 40) {
    const parte = itens.slice(i, i + 40);
    const cnpjs = parte.map((r) => r.cnpj);
    const raizes = [...new Set(parte.map((r) => r.cnpj_raiz))];
    const marcas = (n: number) => Array(n).fill("?").join(",");
    // OR entre colunas mata os indices em base grande: duas queries separadas
    const [qCnpj, qRaiz] = await env.RADAR_DB.batch([
      env.RADAR_DB.prepare(
        `SELECT * FROM radar_estabelecimentos WHERE build_id = ? AND cnpj IN (${marcas(cnpjs.length)})`
      ).bind(build.build_id, ...cnpjs),
      env.RADAR_DB.prepare(
        `SELECT * FROM radar_estabelecimentos WHERE build_id = ? AND cnpj_raiz IN (${marcas(raizes.length)})`
      ).bind(build.build_id, ...raizes),
    ]);
    const porRaiz = new Map<string, Estabelecimento>();
    const linhas = [...(qCnpj.results ?? []), ...(qRaiz.results ?? [])] as unknown as Estabelecimento[];
    const vistos = new Set<string>();
    for (const row of linhas) {
      if (vistos.has(row.cnpj)) continue;
      vistos.add(row.cnpj);
      porCnpj.set(row.cnpj, row);
      if (!porRaiz.has(row.cnpj_raiz)) porRaiz.set(row.cnpj_raiz, row);
    }
    for (const r of itens) {
      if (!porCnpj.has(r.cnpj) && porRaiz.has(r.cnpj_raiz)) {
        porCnpj.set(r.cnpj, porRaiz.get(r.cnpj_raiz)!);
      }
    }
    const ev = await env.RADAR_DB.prepare(
      `SELECT cnpj_raiz, tipo FROM radar_eventos
       WHERE build_id = ? AND cnpj_raiz IN (${marcas(raizes.length)})`
    ).bind(build.build_id, ...raizes).all();
    for (const row of (ev.results ?? []) as { cnpj_raiz: string; tipo: string }[]) {
      const lista = eventosPorRaiz.get(row.cnpj_raiz) ?? [];
      lista.push(row.tipo);
      eventosPorRaiz.set(row.cnpj_raiz, lista);
    }
  }

  // fallback ao vivo para faltantes (limitado), marcando a fonte
  const faltantes = itens.filter((r) => !porCnpj.has(r.cnpj)).slice(0, FALLBACK_LIMITE);
  const fontes = new Map<string, string>();
  for (let i = 0; i < faltantes.length; i += FALLBACK_CONCORRENCIA) {
    const lote = await Promise.all(faltantes.slice(i, i + FALLBACK_CONCORRENCIA)
      .map((r) => buscarBrasilApi(r.cnpj)));
    lote.forEach((estab, j) => {
      if (estab) {
        porCnpj.set(faltantes[i + j].cnpj, estab);
        fontes.set(faltantes[i + j].cnpj, "brasilapi_ao_vivo");
      }
    });
  }

  const runAt = new Date().toISOString();
  const stmts: D1PreparedStatement[] = [];
  let encontrados = 0;
  for (const r of itens) {
    const estab = porCnpj.get(r.cnpj) ?? null;
    if (estab) encontrados++;
    const a = avaliar(estab, eventosPorRaiz.get(r.cnpj_raiz) ?? [], build.competencia);
    (a.detalhes.evidencias as Record<string, unknown>).fonte =
      estab ? fontes.get(r.cnpj) ?? "recorte_rfb" : "nao_encontrado";
    stmts.push(env.RADAR_DB.prepare(
      `INSERT OR REPLACE INTO radar_resultados
       (carteira_id, cnpj, encontrado, score, flags, detalhes, build_id, run_at)
       VALUES (?,?,?,?,?,?,?,?)`
    ).bind(carteiraId, r.cnpj, estab ? 1 : 0, a.score,
           JSON.stringify(a.flags), JSON.stringify(a.detalhes), build.build_id, runAt));
  }
  for (let i = 0; i < stmts.length; i += 100) {
    await env.RADAR_DB.batch(stmts.slice(i, i + 100));
  }
  return json({ carteira_id: carteiraId, avaliados: itens.length, encontrados,
                build_id: build.build_id, competencia: build.competencia, run_at: runAt });
}

async function triage(env: Env, carteiraId: string, url: URL): Promise<Response> {
  const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0) || 0);
  const res = await env.RADAR_DB.prepare(
    `SELECT cnpj, encontrado, score, flags, detalhes FROM radar_resultados
     WHERE carteira_id = ? ORDER BY score DESC, cnpj ASC LIMIT 50 OFFSET ?`
  ).bind(carteiraId, offset).all();
  const itens = (res.results ?? []) as {
    cnpj: string; encontrado: number; score: number; flags: string; detalhes: string;
  }[];
  return json({
    carteira_id: carteiraId, offset, retornados: itens.length,
    proximo_offset: itens.length === 50 ? offset + 50 : null,
    itens: itens.map((r) => ({
      cnpj: formatarCnpj(r.cnpj), encontrado: !!r.encontrado, score: r.score,
      flags: JSON.parse(r.flags), ...JSON.parse(r.detalhes),
    })),
  });
}

function csvSeguro(valor: unknown): string {
  let s = String(valor ?? "");
  if (/^[=+\-@]/.test(s)) s = "'" + s; // neutraliza formula em planilha
  return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function exportar(env: Env, carteiraId: string): Promise<Response> {
  const res = await env.RADAR_DB.prepare(
    `SELECT r.cnpj, r.score, r.flags, r.detalhes, r.build_id
     FROM radar_resultados r WHERE r.carteira_id = ? ORDER BY r.score DESC, r.cnpj ASC`
  ).bind(carteiraId).all();
  const linhas = ["cnpj;razao_social;uf;municipio;cnae_principal;cnae_descricao;simples;mei;score;flags;frase_trabalho;competencia"];
  const [cnaesAll, munsAll] = await Promise.all([
    env.RADAR_DB.prepare(`SELECT codigo, descricao FROM radar_cnaes`).all(),
    env.RADAR_DB.prepare(`SELECT codigo, descricao FROM radar_municipios`).all(),
  ]);
  const cnaeMap = new Map(((cnaesAll.results ?? []) as { codigo: string; descricao: string }[]).map((r) => [r.codigo, r.descricao]));
  const munMap = new Map(((munsAll.results ?? []) as { codigo: string; descricao: string }[]).map((r) => [r.codigo, r.descricao]));
  for (const r of (res.results ?? []) as { cnpj: string; score: number; flags: string; detalhes: string; build_id: string }[]) {
    const d = JSON.parse(r.detalhes) as { frase_trabalho: string; evidencias: Record<string, unknown> };
    const ev = d.evidencias ?? {};
    const cnaeCod = String(ev.cnae_principal ?? "");
    linhas.push([
      formatarCnpj(r.cnpj), ev.razao_social ?? "", ev.uf ?? "",
      munMap.get(String(ev.municipio_codigo ?? "")) ?? ev.municipio_codigo ?? "",
      cnaeCod, cnaeMap.get(cnaeCod) ?? "",
      ev.simples ?? "", ev.mei ?? "", r.score,
      (JSON.parse(r.flags) as string[]).join("|"), d.frase_trabalho, ev.competencia ?? "",
    ].map(csvSeguro).join(";"));
  }
  return new Response(linhas.join("\n"), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="triage-${carteiraId}.csv"`,
    },
  });
}

async function status(env: Env): Promise<Response> {
  const build = await buildAtivo(env);
  const contagens = await env.RADAR_DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM radar_estabelecimentos WHERE build_id = ?) AS estabelecimentos,
       (SELECT COUNT(*) FROM radar_carteiras) AS carteiras,
       (SELECT COUNT(*) FROM radar_resultados) AS resultados`
  ).bind((build as { build_id?: string } | null)?.build_id ?? "").first();
  return json({ build_ativo: build, contagens });
}

/* ---------- consulta instantanea de um CNPJ ---------- */

async function consultaCnpj(env: Env, cnpjRaw: string): Promise<Response> {
  const cnpj = normalizarCnpj(cnpjRaw);
  if (!cnpj) return json({ erro: "formato de CNPJ invalido" }, 400);
  if (!dvValido(cnpj)) return json({ erro: "digito verificador invalido" }, 422);

  const build = await buildAtivo(env) as { build_id: string; competencia: string } | null;
  const competencia = build?.competencia ?? "ao-vivo";
  let estab: Estabelecimento | null = null;
  let fonte = "nao_encontrado";

  if (build) {
    const [qC, qR] = await env.RADAR_DB.batch([
      env.RADAR_DB.prepare(`SELECT * FROM radar_estabelecimentos WHERE build_id = ? AND cnpj = ?`)
        .bind(build.build_id, cnpj),
      env.RADAR_DB.prepare(`SELECT * FROM radar_estabelecimentos WHERE build_id = ? AND cnpj_raiz = ? LIMIT 1`)
        .bind(build.build_id, cnpj.slice(0, 8)),
    ]);
    estab = ((qC.results?.[0] ?? qR.results?.[0]) ?? null) as Estabelecimento | null;
    if (estab) fonte = "recorte_rfb";
  }
  if (!estab) {
    estab = await buscarBrasilApi(cnpj);
    if (estab) fonte = "brasilapi_ao_vivo";
  }

  const a = avaliar(estab, [], competencia);
  a.detalhes.evidencias.fonte = fonte;
  if (estab) {
    const [dc, dm] = await env.RADAR_DB.batch([
      env.RADAR_DB.prepare(`SELECT descricao FROM radar_cnaes WHERE codigo = ?`).bind(estab.cnae_principal),
      env.RADAR_DB.prepare(`SELECT descricao FROM radar_municipios WHERE codigo = ?`).bind(estab.municipio_codigo ?? ""),
    ]);
    a.detalhes.evidencias.cnae_descricao = (dc.results?.[0] as { descricao?: string } | undefined)?.descricao ?? "";
    a.detalhes.evidencias.municipio = (dm.results?.[0] as { descricao?: string } | undefined)?.descricao ?? "";
  }

  // checklist de regras da reforma para o perfil (percepcao de completude)
  type Status = "se_aplica" | "nao_se_aplica" | "verificar";
  const regra = (nome: string, status: Status, detalhe: string) => ({ nome, status, detalhe });
  const regras: ReturnType<typeof regra>[] = [];
  if (estab) {
    const fl = a.flags;
    regras.push(regra("Redução de 30% — profissão regulamentada (art. 127, LC 214)",
      fl.includes("elegivel_127") ? "se_aplica" : "nao_se_aplica",
      fl.includes("elegivel_127")
        ? `CNAE no rol das 18 profissões; verificar requisitos societários na PJ.`
        : "CNAE principal fora do rol taxativo das 18 profissões."));
    regras.push(regra("Redução de 60% — saúde, educação ou cultura (art. 128)",
      fl.includes("elegivel_128") ? "se_aplica" : "nao_se_aplica",
      fl.includes("elegivel_128")
        ? "Setor com redução de 60%; conferir o anexo correspondente (II ou III)."
        : "Fora das divisões de saúde (86-87), educação regular (Anexo II) e cultura/jornalismo."));
    regras.push(regra("Decisão do Simples: CBS/IBS dentro ou fora do DAS (até 30/10/2026)",
      estab.simples === "S" ? "se_aplica" : estab.simples == null ? "verificar" : "nao_se_aplica",
      estab.simples === "S"
        ? "Optante: simular os dois regimes até 30/10 no Portal do Simples; a escolha errada encarece a venda para PJ."
        : estab.simples == null
          ? "Opção pelo Simples não consta na base; confirmar no PGDAS-D."
          : "Não optante do Simples; decisão não se aplica."));
    regras.push(regra("Campos IBS/CBS na NF-e (obrigatório desde 03/08/2026)",
      "se_aplica",
      "Universal: nota sem os campos novos é rejeitada; conferir ERP/emissor e cadastro."));
    regras.push(regra("Coerência do CNAE principal × atividade real",
      fl.includes("cnae_suspeito") ? "se_aplica" : "nao_se_aplica",
      fl.includes("cnae_suspeito")
        ? "CNAE secundário sugere atividade com benefício; revisar enquadramento."
        : "Nenhuma inconsistência detectada entre principal e secundários."));
    regras.push(regra("Guerra de créditos: clientes PJ podem exigir crédito integral",
      "verificar",
      "Depende do perfil dos clientes (PF x PJ) e do regime escolhido; simular com o faturamento."));
    regras.push(regra("Split payment: recolhimento fracionado no pagamento",
      "verificar",
      "Afetará o fluxo de caixa: parte do imposto é retida na liquidação; planejar caixa para 2027+."));
    regras.push(regra("Monitoramento regulatório (atos do Comitê Gestor até 2033)",
      "verificar",
      "Regras seguem mudando na transição; reavaliar este perfil a cada nova competência."));
  }
  return json({
    cnpj: formatarCnpj(cnpj), encontrado: !!estab, score: a.score,
    flags: a.flags, frase_trabalho: a.detalhes.frase_trabalho,
    evidencias: a.detalhes.evidencias, regras,
  });
}

/* ---------- analise agregada + exploracao da base ---------- */

let aggCache: { build: string; dados: unknown; ts: number } | null = null;

async function analiseJson(env: Env): Promise<Response> {
  const build = await buildAtivo(env) as { build_id: string } | null;
  if (!build) return json({ erro: "nenhum build ativo" }, 409);
  if (aggCache && aggCache.build === build.build_id && Date.now() - aggCache.ts < 300_000) {
    return json(aggCache.dados);
  }
  // caminho rapido: snapshot pre-renderizado pelo agregador
  const snap = await env.SNAPSHOTS.get(`radar/aggs/${build.build_id}-painel.json`);
  if (snap) {
    const dados = await snap.json();
    aggCache = { build: build.build_id, dados, ts: Date.now() };
    return json(dados);
  }
  const obj = await env.SNAPSHOTS.get(`radar/aggs/${build.build_id}.json`);
  if (!obj) return json({ erro: "agregados ainda nao gerados para este build" }, 404);
  const agg = (await obj.json()) as {
    total: number; flags: Record<string, number>; competencia: string;
    por_cnae: Record<string, { n: number; simples: number; eleg127: number }>;
    por_municipio: Record<string, { n: number; simples: number }>;
    por_porte: Record<string, { n: number }>;
  };
  // enriquecer com descricoes das dimensoes
  const [cnaesAll, munsAll] = await Promise.all([
    env.RADAR_DB.prepare(`SELECT codigo, descricao FROM radar_cnaes`).all(),
    env.RADAR_DB.prepare(`SELECT codigo, descricao FROM radar_municipios`).all(),
  ]);
  const cnaeDesc = new Map(((cnaesAll.results ?? []) as { codigo: string; descricao: string }[]).map((r) => [r.codigo, r.descricao]));
  const munDesc = new Map(((munsAll.results ?? []) as { codigo: string; descricao: string }[]).map((r) => [r.codigo, r.descricao]));
  const topCnaes = Object.entries(agg.por_cnae)
    .map(([codigo, d]) => ({ codigo, descricao: cnaeDesc.get(codigo) ?? "", ...d }))
    .sort((a, b) => b.n - a.n).slice(0, 60);
  const topMunicipios = Object.entries(agg.por_municipio)
    .map(([codigo, d]) => ({ codigo, nome: munDesc.get(codigo) ?? codigo, ...d }))
    .sort((a, b) => b.n - a.n).slice(0, 40);
  const dados = {
    build_id: build.build_id, competencia: agg.competencia, total: agg.total,
    flags: agg.flags, por_porte: agg.por_porte,
    top_cnaes: topCnaes, top_municipios: topMunicipios,
  };
  aggCache = { build: build.build_id, dados, ts: Date.now() };
  return json(dados);
}

async function explorar(env: Env, url: URL): Promise<Response> {
  const build = await buildAtivo(env) as { build_id: string } | null;
  if (!build) return json({ erro: "nenhum build ativo" }, 409);
  const cnae = (url.searchParams.get("cnae") ?? "").replace(/[^0-9]/g, "");
  const simples = url.searchParams.get("simples") === "S" ? "S" : null;
  const limite = Math.min(Number(url.searchParams.get("limit") ?? 50) || 50, 200);
  const where: string[] = ["build_id = ?"];
  const params: (string | number)[] = [build.build_id];
  if (cnae) { where.push("cnae_principal = ?"); params.push(cnae); }
  if (simples) { where.push("simples = ?"); params.push(simples); }
  const res = await env.RADAR_DB.prepare(
    `SELECT cnpj, razao_social, nome_fantasia, municipio_codigo, uf, cnae_principal,
            cnaes_secundarios, porte, simples, mei, data_inicio, matriz_filial
     FROM radar_estabelecimentos WHERE ${where.join(" AND ")}
     ORDER BY cnpj LIMIT ?`
  ).bind(...params, limite).all();
  return json({ build_id: build.build_id, retornados: (res.results ?? []).length,
                itens: res.results ?? [] });
}

/* ---------- monitoramento do pipeline ---------- */

async function pipelineJson(env: Env): Promise<Response> {
  const obj = await env.SNAPSHOTS.get("radar/status/atual.json");
  if (!obj) return json({ status: "nenhuma execucao registrada ainda" });
  return new Response(obj.body, { headers: JSONH });
}

/* ---------- painel: plano + status por arquivo ---------- */

interface ArqStatus {
  nome: string; status?: string; mb_baixados?: number; mb_total?: number;
  mbps?: number; linhas?: number; mantidas?: number; atualizado_em?: string;
}

async function painelJson(env: Env): Promise<Response> {
  const [planoObj, lista, atualObj] = await Promise.all([
    env.SNAPSHOTS.get("radar/status/plano.json"),
    env.SNAPSHOTS.list({ prefix: "radar/status/files/" }),
    env.SNAPSHOTS.get("radar/status/atual.json"),
  ]);
  const plano = planoObj
    ? (await planoObj.json()) as { competencia: string; itens: { nome: string; kind: string }[] }
    : { competencia: null, itens: [] as { nome: string; kind: string }[] };
  const statusPorNome = new Map<string, ArqStatus>();
  await Promise.all(lista.objects.map(async (o) => {
    const obj = await env.SNAPSHOTS.get(o.key);
    if (!obj) return;
    try {
      const st = (await obj.json()) as ArqStatus;
      statusPorNome.set(st.nome ?? o.key.split("/").pop()!.replace(/\.json$/, ""), st);
    } catch { /* ignora entrada quebrada */ }
  }));
  const arquivos = plano.itens.map((it) => {
    const st = statusPorNome.get(it.nome) ?? null;
    const pct = st?.mb_baixados != null && st.mb_total
      ? Math.min(100, Math.round((st.mb_baixados / st.mb_total) * 100))
      : st?.status === "concluido" ? 100 : 0;
    return { nome: it.nome, kind: it.kind, status: st?.status ?? "pendente",
             pct, mb_baixados: st?.mb_baixados ?? null, mb_total: st?.mb_total ?? null,
             mbps: st?.mbps ?? null, linhas: st?.linhas ?? null,
             mantidas: st?.mantidas ?? null, atualizado_em: st?.atualizado_em ?? null };
  });
  const heartbeat = atualObj ? await atualObj.json() : null;
  return json({ competencia: plano.competencia, heartbeat, arquivos });
}

const MONITOR_HTML = `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Radar — painel de downloads</title>
<style>
  body{font-family:ui-monospace,Menlo,monospace;background:#0b0f14;color:#d7e0ea;max-width:860px;margin:32px auto;padding:0 14px}
  h1{font-size:17px;color:#7ee0a3;margin-bottom:4px}
  .sub{color:#7a8ca0;font-size:12px;margin-bottom:14px}
  .card{background:#131a22;border:1px solid #243242;border-radius:10px;padding:12px 14px;margin:10px 0}
  .k{color:#7a8ca0;font-size:11px} .v{font-size:16px;margin-top:2px}
  table{width:100%;border-collapse:collapse;font-size:12px}
  td,th{padding:6px 8px;border-bottom:1px solid #1d2836;text-align:left;white-space:nowrap}
  th{color:#7a8ca0;font-weight:normal;font-size:11px}
  .barra{height:8px;background:#1d2836;border-radius:4px;overflow:hidden;width:140px}
  .barra>div{height:100%;background:#7ee0a3;transition:width .5s}
  .st-concluido{color:#7ee0a3}.st-baixando{color:#ffd479}.st-pendente{color:#5a6a80}
  input{background:#0b0f14;border:1px solid #243242;color:#d7e0ea;padding:6px 8px;border-radius:6px;width:220px}
  button{background:#1d2836;color:#d7e0ea;border:1px solid #243242;border-radius:6px;padding:6px 10px;cursor:pointer}
  #status{font-size:11px;color:#7a8ca0;margin-top:12px}
</style></head><body>
<h1>RADAR · painel de downloads</h1>
<div class="sub" id="comp">—</div>

<div class="card"><div class="k">agora</div><div class="v" id="fase">—</div></div>
<div class="card"><table>
  <thead><tr><th>arquivo</th><th>grupo</th><th>progresso</th><th>%</th><th>vel.</th><th>status</th></tr></thead>
  <tbody id="rows"></tbody>
</table></div>
<div id="status">atualizando a cada 15s…</div>
<script>
const key = "";
const fmt = n => n == null ? "—" : Number(n).toLocaleString("pt-BR");
function linha(a){
  return "<tr><td>" + a.nome + "</td><td>" + a.kind + "</td>"
    + '<td><div class="barra"><div style="width:' + a.pct + '%"></div></div></td>'
    + "<td>" + a.pct + "%</td>"
    + "<td>" + (a.mbps != null ? a.mbps + " MB/s" : "—") + "</td>"
    + '<td class="st-' + a.status + '">' + a.status + "</td></tr>";
}
async function tick(){
  try{
    const r = await fetch("/api/radar/painel");
    const d = await r.json();
    document.getElementById("comp").textContent =
      "competencia " + (d.competencia || "—") + " · " + d.arquivos.length + " arquivos";
    const hb = d.heartbeat || {};
    document.getElementById("fase").textContent =
      (hb.fase || "—") + (hb.arquivo ? " · " + hb.arquivo : "")
      + (hb.mb_baixados != null ? " · " + fmt(hb.mb_baixados) + (hb.mb_total ? "/" + fmt(hb.mb_total) : "") + " MB" : "");
    const ord = {baixando: 0, download_retentativa: 0, pendente: 1, concluido: 2};
    d.arquivos.sort((x, y) => (ord[x.status] ?? 1) - (ord[y.status] ?? 1) || x.nome.localeCompare(y.nome));
    document.getElementById("rows").innerHTML = d.arquivos.map(linha).join("");
    document.getElementById("status").textContent = "atualizado: " + new Date().toLocaleTimeString("pt-BR");
  }catch(e){ document.getElementById("status").textContent = "falha: " + e.message; }
}
tick(); setInterval(tick, 15000);
</script></body></html>`;

const PRO_HTML = `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Radar Tributário — Triagem de Carteira</title>
<style>
  *{box-sizing:border-box}
  body{font-family:system-ui,-apple-system,sans-serif;background:#0b0f14;color:#d7e0ea;margin:0;padding:24px}
  .wrap{max-width:1100px;margin:0 auto}
  h1{font-size:19px;color:#7ee0a3;margin:0}
  .sub{color:#7a8ca0;font-size:12px;margin:4px 0 16px}
  .card{background:#131a22;border:1px solid #243242;border-radius:10px;padding:14px 16px;margin:10px 0}
  .k{color:#7a8ca0;font-size:11px;text-transform:uppercase;letter-spacing:.05em}
  .stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px}
  .stat .v{font-size:22px;margin-top:2px}
  textarea{width:100%;min-height:110px;background:#0b0f14;border:1px solid #243242;color:#d7e0ea;border-radius:8px;padding:10px;font-family:ui-monospace,monospace;font-size:12px}
  input[type=text],input[type=password]{background:#0b0f14;border:1px solid #243242;color:#d7e0ea;padding:7px 10px;border-radius:7px}
  button{background:#1d6f4a;color:#fff;border:0;border-radius:7px;padding:9px 16px;cursor:pointer;font-weight:600}
  button.sec{background:#1d2836;border:1px solid #243242}
  button:disabled{opacity:.5;cursor:wait}
  table{width:100%;border-collapse:collapse;font-size:12px}
  td,th{padding:7px 8px;border-bottom:1px solid #1d2836;text-align:left;vertical-align:top}
  th{color:#7a8ca0;font-weight:600;font-size:11px;position:sticky;top:0;background:#131a22}
  .badge{display:inline-block;padding:2px 8px;border-radius:20px;font-size:10px;font-weight:700;margin:1px 2px}
  .b-elegivel_127{background:#14462e;color:#7ee0a3}
  .b-elegivel_128{background:#123a4a;color:#6fc3ff}
  .b-decisao_simples{background:#4a3a12;color:#ffd479}
  .b-cnae_suspeito{background:#4a2a12;color:#ffab70}
  .b-cnae_mudou{background:#123a4a;color:#6fc3ff}
  .b-nao_encontrado{background:#3a1d1d;color:#ff8a8a}
  .score{font-weight:700;font-size:14px}
  .frase{color:#9fb0c3;font-size:11px}
  .scroll{max-height:520px;overflow:auto}
  .row-nao{opacity:.55}
  #msg{font-size:12px;color:#ffd479;min-height:16px;margin-top:8px}
  select{background:#0b0f14;border:1px solid #243242;color:#d7e0ea;padding:7px;border-radius:7px}
</style></head><body>
<div class="wrap">
<h1>RADAR TRIBUTÁRIO</h1>
<div class="sub">triagem de carteira para a reforma — <span id="build">—</span> · <a href="/radar" style="color:#6fc3ff">painel de downloads</a></div>
<div style="display:flex;gap:8px;margin-bottom:10px">
  <button class="sec" id="tab-carteira" onclick="aba('carteira')">Carteira</button>
  <button class="sec" id="tab-explorar" onclick="aba('explorar')">Explorar a base × reforma</button>
</div>

<div class="card" id="auth">
  <span class="k">chave de acesso</span><br>
  <input type="password" id="chave" style="width:280px"> <button onclick="entrar()">entrar</button>
</div>

<div id="app" style="display:none">
<div id="view-carteira">
  <div class="card stats">
    <div class="stat"><div class="k">na carteira</div><div class="v" id="st-total">—</div></div>
    <div class="stat"><div class="k">encontrados</div><div class="v" id="st-enc">—</div></div>
    <div class="stat"><div class="k">elegíveis 30%</div><div class="v" id="st-127">—</div></div>
    <div class="stat"><div class="k">decisão Simples</div><div class="v" id="st-sim">—</div></div>
    <div class="stat"><div class="k">CNAE suspeito</div><div class="v" id="st-sus">—</div></div>
  </div>

  <div class="card">
    <div class="k">1 · carteira de CNPJs (cole ou escolha o CSV do contador)</div>
    <textarea id="cnpjs" placeholder="cnpj
11.222.333/0001-81
..."></textarea>
    <div style="margin-top:8px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">
      <input type="file" id="arquivo" accept=".csv,.txt">
      <button id="btn-go" onclick="cruzarTudo()">Criar carteira e cruzar</button>
      <span id="msg"></span>
    </div>
  </div>

  <div class="card" id="card-res" style="display:none">
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:8px">
      <span class="k">2 · triagem</span>
      <select id="f-flag" onchange="render()">
        <option value="">todas as flags</option>
        <option value="elegivel_127">elegível 30% (art. 127)</option>
        <option value="elegivel_128">saúde 60% (art. 128)</option>
        <option value="decisao_simples">decisão Simples</option>
        <option value="cnae_suspeito">CNAE suspeito</option>
        <option value="cnae_mudou">CNAE mudou</option>
        <option value="__nao">não encontrados</option>
      </select>
      <input type="text" id="f-busca" placeholder="buscar razão social / CNPJ" oninput="render()" style="width:240px">
      <span style="flex:1"></span>
      <button class="sec" onclick="baixarCsv()">baixar CSV do contador</button>
    </div>
    <div class="scroll"><table>
      <thead><tr><th>score</th><th>CNPJ</th><th>razão social</th><th>município</th><th>CNAE</th><th>Simples</th><th>flags</th><th>ação de trabalho</th></tr></thead>
      <tbody id="rows"></tbody>
    </table></div>
  </div>
</div>

</div>
<div id="view-explorar" style="display:none">
  <div class="card">
    <div class="k">premissas de receita (edite e veja a otimização)</div>
    <div style="display:flex;gap:14px;flex-wrap:wrap;margin-top:6px;font-size:12px;align-items:center">
      <span>fee por re-enquadramento R$ <input id="p-fee" type="text" value="500" style="width:70px" oninput="renderOport()"></span>
      <span>assinatura monitoramento R$/mês <input id="p-assin" type="text" value="97" style="width:60px" oninput="renderOport()"></span>
      <span>conversão da carteira % <input id="p-conv" type="text" value="10" style="width:50px" oninput="renderOport()"></span>
    </div>
  </div>
  <div class="card stats">
    <div class="stat"><div class="k">base SP serviços</div><div class="v" id="op-total">—</div></div>
    <div class="stat"><div class="k">elegíveis 30% (art.127)</div><div class="v" id="op-127">—</div></div>
    <div class="stat"><div class="k">potencial 127 (setup)</div><div class="v" id="op-127r">—</div></div>
    <div class="stat"><div class="k">decisão Simples</div><div class="v" id="op-sim">—</div></div>
    <div class="stat"><div class="k">potencial anual recorrente</div><div class="v" id="op-rec">—</div></div>
  </div>
  <div class="card">
    <div class="k">top CNAEs de serviço (clique para ver empresas)</div>
    <div class="scroll"><table>
      <thead><tr><th>CNAE</th><th>descrição</th><th>empresas</th><th>no Simples</th><th>elegíveis 127</th></tr></thead>
      <tbody id="tb-cnaes"></tbody>
    </table></div>
  </div>
  <div class="card">
    <div class="k">top municípios</div>
    <div class="scroll" style="max-height:260px"><table>
      <thead><tr><th>município</th><th>empresas</th><th>no Simples</th></tr></thead>
      <tbody id="tb-muns"></tbody>
    </table></div>
  </div>
  <div class="card" id="card-drill" style="display:none">
    <div class="k" id="drill-titulo">empresas</div>
    <div class="scroll"><table>
      <thead><tr><th>CNPJ</th><th>razão social</th><th>município</th><th>Simples</th><th>MEI</th><th>início</th></tr></thead>
      <tbody id="tb-drill"></tbody>
    </table></div>
  </div>
</div>
<div class="sub" id="rodape"></div>
</div>
<script>
let ITENS = [];
let CARTEIRA = localStorage.getItem("radar_carteira") || "";

const $ = id => document.getElementById(id);
const fmt = n => n == null ? "—" : Number(n).toLocaleString("pt-BR");

async function api(path, opts){
  opts = opts || {};
  opts.headers = Object.assign({"x-radar-key": KEY}, opts.headers || {});
  const r = await fetch(path, opts);
  if (r.status === 401){ $("auth").style.display = "block"; throw new Error("chave inválida"); }
  return r;
}
function entrar(){
  KEY = $("chave").value.trim();
  localStorage.setItem("radar_key", KEY);
  iniciar();
}
async function iniciar(){
  try{
    const r = await api("/api/radar/status");
    const d = await r.json();
    $("auth").style.display = "none";
    $("app").style.display = "block";
    const b = d.build_ativo || {};
    $("build").textContent = b.build_id
      ? "base própria " + b.competencia + " · " + fmt(b.total_registros) + " empresas"
      : "modo ao-vivo (BrasilAPI)";
    if (CARTEIRA){ await carregarTriage(); }
  }catch(e){ $("auth").style.display = "block"; }
}

async function cruzarTudo(){
  const txt = $("cnpjs").value.trim();
  if (!txt){ msg("cole os CNPJs ou escolha o arquivo"); return; }
  $("btn-go").disabled = true; msg("criando carteira…");
  try{
    let r = await api("/api/radar/carteiras", {method: "POST",
      headers: {"content-type": "text/csv"}, body: txt});
    let d = await r.json();
    if (!r.ok){ msg(d.erro || "erro ao criar carteira"); return; }
    CARTEIRA = d.carteira_id;
    localStorage.setItem("radar_carteira", CARTEIRA);
    msg("carteira " + CARTEIRA + " · " + d.total + " válidos, " + d.invalidos + " inválidos · cruzando…");
    r = await api("/api/radar/carteiras/" + CARTEIRA + "/cruzar", {method: "POST"});
    d = await r.json();
    if (!r.ok){ msg(d.erro || "erro ao cruzar"); return; }
    msg("cruzados " + fmt(d.avaliados) + " · encontrados " + fmt(d.encontrados) + " · fonte: " + d.competencia);
    await carregarTriage();
  }catch(e){ msg("falha: " + e.message); }
  finally{ $("btn-go").disabled = false; }
}

async function carregarTriage(){
  ITENS = [];
  let offset = 0;
  for(;;){
    const r = await api("/api/radar/triage/" + CARTEIRA + "?offset=" + offset);
    const d = await r.json();
    if (!r.ok){ msg(d.erro || "erro na triagem"); return; }
    ITENS = ITENS.concat(d.itens || []);
    if (d.proximo_offset == null) break;
    offset = d.proximo_offset;
  }
  $("card-res").style.display = "block";
  render();
}

function temFlag(it, f){ return (it.flags || []).indexOf(f) >= 0; }

function render(){
  const f = $("f-flag").value;
  const q = $("f-busca").value.toLowerCase();
  const vis = ITENS.filter(it => {
    if (f === "__nao" && it.encontrado) return false;
    if (f && f !== "__nao" && !temFlag(it, f)) return false;
    const ev = it.evidencias || {};
    const texto = ((ev.razao_social || "") + " " + it.cnpj).toLowerCase();
    return !q || texto.indexOf(q) >= 0;
  });
  $("st-total").textContent = fmt(ITENS.length);
  $("st-enc").textContent = fmt(ITENS.filter(i => i.encontrado).length);
  $("st-127").textContent = fmt(ITENS.filter(i => temFlag(i, "elegivel_127")).length);
  $("st-sim").textContent = fmt(ITENS.filter(i => temFlag(i, "decisao_simples")).length);
  $("st-sus").textContent = fmt(ITENS.filter(i => temFlag(i, "cnae_suspeito")).length);
  $("rows").innerHTML = vis.map(it => {
    const ev = it.evidencias || {};
    const flags = it.encontrado
      ? (it.flags || []).map(f => '<span class="badge b-' + f + '">' + f + "</span>").join("")
      : '<span class="badge b-nao_encontrado">não encontrado</span>';
    return '<tr class="' + (it.encontrado ? "" : "row-nao") + '">'
      + '<td class="score">' + it.score + "</td>"
      + "<td>" + it.cnpj + "</td>"
      + "<td>" + (ev.razao_social || "—") + "</td>"
      + "<td>" + (ev.municipio_codigo || "—") + "/" + (ev.uf || "") + "</td>"
      + "<td>" + (ev.cnae_principal || "—") + "</td>"
      + "<td>" + (ev.simples || "—") + "</td>"
      + "<td>" + flags + "</td>"
      + '<td class="frase">' + (it.frase_trabalho || "") + "</td></tr>";
  }).join("");
  $("rodape").textContent = vis.length + " de " + ITENS.length + " empresas · carteira " + CARTEIRA;
}

async function baixarCsv(){
  const r = await api("/api/radar/triage/" + CARTEIRA + "/export");
  const blob = await r.blob();
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "triage-" + CARTEIRA + ".csv";
  a.click();
}

$("arquivo").addEventListener("change", ev => {
  const f = ev.target.files[0];
  if (!f) return;
  const rd = new FileReader();
  rd.onload = () => { $("cnpjs").value = rd.result; };
  rd.readAsText(f);
});
function msg(t){ $("msg").textContent = t; }

let AGG = null;
function aba(v){
  $("view-carteira").style.display = v === "carteira" ? "block" : "none";
  $("view-explorar").style.display = v === "explorar" ? "block" : "none";
  $("tab-carteira").style.background = v === "carteira" ? "#1d6f4a" : "#1d2836";
  $("tab-explorar").style.background = v === "explorar" ? "#1d6f4a" : "#1d2836";
  if (v === "explorar" && !AGG) carregarAnalise();
}
async function carregarAnalise(){
  try{
    const r = await api("/api/radar/analise");
    const d = await r.json();
    if (!r.ok){ alert(d.erro || "agregados indisponiveis"); return; }
    AGG = d;
    renderExplorar();
  }catch(e){ alert("falha: " + e.message); }
}
function moeda(n){ return "R$ " + Math.round(n).toLocaleString("pt-BR"); }
function num(id){ return parseFloat($(id).value.replace(",", ".")) || 0; }
function renderOport(){
  if (!AGG) return;
  const fee = num("p-fee"), assin = num("p-assin"), conv = num("p-conv") / 100;
  const f = AGG.flags || {};
  const n127 = f.elegivel_127 || 0, nSim = f.decisao_simples || 0;
  $("op-total").textContent = fmt(AGG.total);
  $("op-127").textContent = fmt(n127);
  $("op-sim").textContent = fmt(nSim);
  $("op-127r").textContent = moeda(n127 * fee * conv);
  $("op-rec").textContent = moeda((n127 + nSim) * conv * assin * 12) + "/ano";
}
function renderExplorar(){
  renderOport();
  $("tb-cnaes").innerHTML = (AGG.top_cnaes || []).map(c =>
    '<tr style="cursor:pointer" onclick="drill(&quot;' + c.codigo + '&quot;,this)">'
    + "<td>" + c.codigo + "</td><td>" + (c.descricao || "—") + "</td>"
    + "<td>" + fmt(c.n) + "</td><td>" + fmt(c.simples) + "</td>"
    + "<td>" + fmt(c.eleg127) + "</td></tr>").join("");
  $("tb-muns").innerHTML = (AGG.top_municipios || []).map(m =>
    "<tr><td>" + m.nome + "</td><td>" + fmt(m.n) + "</td><td>" + fmt(m.simples) + "</td></tr>").join("");
}
async function drill(codigo, tr){
  $("card-drill").style.display = "block";
  $("drill-titulo").textContent = "empresas do CNAE " + codigo + " (amostra de 100)";
  $("tb-drill").innerHTML = "<tr><td>carregando…</td></tr>";
  const r = await api("/api/radar/explorar?cnae=" + codigo + "&limit=100");
  const d = await r.json();
  $("tb-drill").innerHTML = (d.itens || []).map(e =>
    "<tr><td>" + e.cnpj + "</td><td>" + (e.razao_social || "") + "</td><td>"
    + (e.municipio_codigo || "") + "/" + (e.uf || "") + "</td><td>" + (e.simples || "—")
    + "</td><td>" + (e.mei || "—") + "</td><td>" + (e.data_inicio || "—") + "</td></tr>").join("");
}
if (KEY){ iniciar(); } else { $("auth").style.display = "block"; }
</script></body></html>`;


const DASH_HTML = `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Radar da Reforma — mapa do mercado</title>
<style>
  *{box-sizing:border-box}
  body{font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",sans-serif;
       background:#f4f5f8;color:#1d1d1f;margin:0;-webkit-font-smoothing:antialiased}
  .topo{background:#fff;border-bottom:1px solid #e6e6ea;padding:14px 22px;display:flex;gap:16px;align-items:center;flex-wrap:wrap}
  .topo h1{font-size:18px;margin:0;letter-spacing:-.02em}
  .topo h1 b{color:#0071e3}
  .topo .conf{font-size:11.5px;color:#86868b}
  .busca{margin-left:auto;display:flex;gap:8px}
  .busca input{border:1px solid #d2d2d7;border-radius:980px;padding:9px 16px;font-size:13px;width:230px;outline:none}
  .busca input:focus{border-color:#0071e3}
  .btn{background:#0071e3;color:#fff;border:0;border-radius:980px;padding:10px 20px;font-size:13px;font-weight:600;cursor:pointer}
  .btn.sec{background:#e8e8ed;color:#1d1d1f}
  .wrap{max-width:1120px;margin:0 auto;padding:22px 18px 80px}
  .kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin-bottom:16px}
  .kpi{background:#fff;border-radius:16px;padding:16px 18px;border:1px solid #eaeaee;box-shadow:0 1px 3px rgba(0,0,0,.04)}
  .kpi .n{font-size:27px;font-weight:700;letter-spacing:-.02em;margin-top:4px}
  .kpi .l{font-size:11.5px;color:#86868b;text-transform:uppercase;letter-spacing:.05em;font-weight:600}
  .kpi.verde .n{color:#0d7a3f}.kpi.azul .n{color:#0071e3}.kpi.ambar .n{color:#b25e00}.kpi.roxo .n{color:#6c3fb5}
  .grade{display:grid;grid-template-columns:2fr 1fr;gap:14px}
  @media(max-width:900px){.grade{grid-template-columns:1fr}}
  .card{background:#fff;border-radius:16px;padding:18px;border:1px solid #eaeaee;box-shadow:0 1px 3px rgba(0,0,0,.04);margin-bottom:14px}
  .card h2{font-size:15px;margin:0 0 2px}
  .card .sub{font-size:12px;color:#86868b;margin-bottom:10px}
  table{width:100%;border-collapse:collapse;font-size:12.5px}
  th{text-align:left;font-size:10.5px;color:#86868b;text-transform:uppercase;letter-spacing:.04em;padding:7px 8px;border-bottom:1px solid #eee}
  td{padding:8px;border-bottom:1px solid #f3f3f5}
  tr.linha{cursor:pointer}
  tr.linha:hover{background:#f6f9ff}
  .barra{height:9px;background:#eef0f4;border-radius:5px;overflow:hidden;min-width:90px}
  .barra > div{height:100%;border-radius:5px}
  .td-num{text-align:right;font-variant-numeric:tabular-nums}
  .tag{display:inline-block;border-radius:980px;padding:2px 9px;font-size:10px;font-weight:700}
  .t-verde{background:#e8f7ee;color:#0d7a3f}.t-azul{background:#e7f1fd;color:#0071e3}.t-ambar{background:#fff4d6;color:#8a6100}
  .voltar{font-size:13px;color:#0071e3;cursor:pointer;margin-bottom:8px;display:inline-block}
  .pill{display:inline-block;border-radius:980px;padding:4px 12px;font-size:11px;font-weight:600;margin:4px 6px 0 0}
  .p-verde{background:#e8f7ee;color:#0d7a3f}.p-amarela{background:#fff4d6;color:#8a6100}.p-cinza{background:#f5f5f7;color:#6e6e73}
  .fatos{display:grid;grid-template-columns:1fr 1fr;gap:8px 16px;margin-top:12px}
  .fato .k{font-size:11px;color:#86868b;text-transform:uppercase;letter-spacing:.04em}
  .fato .v{font-size:14px;margin-top:1px}
  .regra{display:flex;gap:12px;align-items:flex-start;padding:12px 0;border-top:1px solid #eeeef0}
  .regra:first-child{border-top:0}
  .ico{flex:0 0 26px;height:26px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:700}
  .i-sim{background:#e8f7ee;color:#0d7a3f}.i-nao{background:#f5f5f7;color:#86868b}.i-ver{background:#fff4d6;color:#8a6100}
  .regra .nome{font-size:14px;font-weight:600;line-height:1.35}
  .regra .det{font-size:12.5px;color:#6e6e73;margin-top:2px;line-height:1.45}
  .passo{display:flex;gap:12px;padding:11px 0;border-top:1px solid #eeeef0;font-size:14px;line-height:1.5}
  .passo:first-child{border-top:0}
  .passo .num{flex:0 0 26px;height:26px;border-radius:50%;background:#0071e3;color:#fff;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700}
  .economia{text-align:center;background:#f0f7ff;border:1px solid #cfe4ff}
  .economia .n{font-size:36px;font-weight:700;color:#0071e3}
  .economia input{width:110px;border:1px solid #d2d2d7;border-radius:8px;padding:6px 8px;font-size:13px;text-align:right}
  #msg{font-size:12.5px;color:#86868b;text-align:center;margin-top:10px;min-height:16px}
  input.prem{border:1px solid #d2d2d7;border-radius:8px;padding:5px 7px;font-size:12px;text-align:right;width:64px}
</style></head><body>
<div class="topo">
  <div>
    <h1>Radar da <b>Reforma</b></h1>
    <div class="conf">base própria Receita Federal · <span id="conf-base">—</span> · LC 214/2025</div>
  </div>
  <div class="busca">
    <input id="cnpj" placeholder="consultar um CNPJ…" inputmode="numeric">
    <button class="btn" onclick="consultar()">Buscar</button>
  </div>
</div>
<div class="wrap">
  <div class="kpis">
    <div class="kpi azul"><div class="l">empresas na base</div><div class="n" id="k-total">—</div></div>
    <div class="kpi verde"><div class="l">elegíveis 30% (art.127)</div><div class="n" id="k-127">—</div></div>
    <div class="kpi roxo"><div class="l">saúde/educ./cultura 60%</div><div class="n" id="k-128">—</div></div>
    <div class="kpi ambar"><div class="l">decisão Simples</div><div class="n" id="k-sim">—</div></div>
    <div class="kpi"><div class="l">potencial · ticket R$ <input class="prem" id="ticket" value="500" oninput="renderAll()"></div><div class="n" id="k-pot">—</div></div>
  </div>

  <div id="dash">
    <div class="grade">
      <div class="card">
        <h2>Onde está o dinheiro — por CNAE</h2>
        <div class="sub">ranking por potencial de mercado (elegíveis × ticket) · clique para ver as empresas</div>
        <table>
          <thead><tr><th>CNAE / atividade</th><th class="td-num">empresas</th><th class="td-num">elegíveis</th><th>participação</th><th class="td-num">potencial</th></tr></thead>
          <tbody id="rank"></tbody>
        </table>
      </div>
      <div>
        <div class="card">
          <h2>Top municípios</h2>
          <div class="sub">empresas de serviço por cidade</div>
          <table><tbody id="muns"></tbody></table>
        </div>
        <div class="card">
          <h2>Por porte</h2>
          <div class="sub">distribuição da base</div>
          <table><tbody id="portes"></tbody></table>
        </div>
      </div>
    </div>
  </div>

  <div id="drill" style="display:none">
    <span class="voltar" onclick="voltarDash()">← voltar ao mapa</span>
    <div class="card">
      <h2 id="drill-titulo">empresas</h2>
      <div class="sub" id="drill-sub">amostra de 100 · clique para abrir a ficha completa</div>
      <table>
        <thead><tr><th>razão social</th><th>CNPJ</th><th>município</th><th>Simples</th><th>abertura</th></tr></thead>
        <tbody id="empresas"></tbody>
      </table>
    </div>
  </div>

  <div id="ficha" style="display:none">
    <span class="voltar" onclick="voltarDash()">← voltar</span>
    <div class="card">
      <h2 id="f-nome">—</h2>
      <div class="sub" id="f-sub">—</div>
      <div class="fatos">
        <div class="fato"><div class="k">Atividade principal</div><div class="v" id="f-cnae">—</div></div>
        <div class="fato"><div class="k">Regime</div><div class="v" id="f-regime">—</div></div>
        <div class="fato"><div class="k">Município</div><div class="v" id="f-mun">—</div></div>
        <div class="fato"><div class="k">Abertura</div><div class="v" id="f-abert">—</div></div>
      </div>
      <div id="f-pills"></div>
    </div>
    <div class="card economia" id="card-eco" style="display:none">
      <div style="font-size:13px;color:#6e6e73">Quanto a empresa paga de imposto por ano? R$ <input id="imp-ano" value="120000" oninput="calcEco()"></div>
      <div class="n" id="eco-n">R$ 0</div>
      <div style="font-size:12.5px;color:#6e6e73" id="eco-l">potencial de economia por ano</div>
    </div>
    <div class="card">
      <h2>O que a reforma muda para esta empresa</h2>
      <div class="sub">cada regra avaliada, uma a uma — LC 214/2025</div>
      <div id="regras"></div>
    </div>
    <div class="card">
      <h2>O que fazer agora</h2>
      <div class="passo"><div class="num">1</div><div>Guarde este diagnóstico (copie a mensagem abaixo).</div></div>
      <div class="passo"><div class="num">2</div><div>Envie para quem cuida da contabilidade com prazo. <b>Você não precisa entender — precisa cobrar.</b></div></div>
      <div class="passo"><div class="num">3</div><div>Sem resposta clara em 7 dias? A empresa está mal assessorada — e isso custa dinheiro todo mês.</div></div>
      <div style="text-align:center;margin-top:12px">
        <button class="btn" onclick="copiarDelegacao(this)">📋 Copiar mensagem de cobrança</button>
      </div>
    </div>
  </div>
  <div id="msg"></div>
</div>
<script>
let AGG = null, DADO = null;
function normalizarCnpjCli(entrada){
  const limpo = String(entrada || "").toUpperCase().replace(/[^0-9A-Z]/g, "");
  if (limpo.length !== 14 || !/^[0-9A-Z]{12}[0-9]{2}$/.test(limpo)) return null;
  return limpo;
}
function _valorC(c){ return c.charCodeAt(0) - 48; }
function _digC(base){
  let soma = 0;
  for (let j = 0; j < base.length; j++) soma += _valorC(base[j]) * (((base.length - 1 - j) % 8) + 2);
  const resto = soma % 11;
  return resto < 2 ? "0" : String(11 - resto);
}
function dvValidoC(c){ const b = c.slice(0, 12); return _digC(b) === c[12] && _digC(b + c[12]) === c[13]; }
function mascaraCnpjInput(input){
  input.addEventListener("input", () => {
    const l = input.value.toUpperCase().replace(/[^0-9A-Z]/g, "").slice(0, 14);
    let out = l;
    if (l.length > 12) out = l.slice(0,2) + "." + l.slice(2,5) + "." + l.slice(5,8) + "/" + l.slice(8,12) + "-" + l.slice(12);
    else if (l.length > 8) out = l.slice(0,2) + "." + l.slice(2,5) + "." + l.slice(5,8) + "/" + l.slice(8);
    else if (l.length > 5) out = l.slice(0,2) + "." + l.slice(2,5) + "." + l.slice(5);
    else if (l.length > 2) out = l.slice(0,2) + "." + l.slice(2);
    input.value = out;
  });
}
const $ = id => document.getElementById(id);
const fmt = n => n == null ? "—" : Number(n).toLocaleString("pt-BR");
async function api(path, opts){ return fetch(path, opts || {}); }
function msg(t){ $("msg").textContent = t; }

async function iniciar(){
  $("rank").innerHTML = '<tr><td style="color:#86868b;padding:18px">carregando o mapa do mercado…</td></tr>';
  let r, d;
  try{
    r = await api("/api/radar/analise");
    d = await r.json();
  }catch(e){
    $("rank").innerHTML = '<tr><td style="padding:18px">falha ao carregar — <a href="#" onclick="iniciar();return false" style="color:#0071e3">tentar de novo</a></td></tr>';
    return;
  }
  if (!r.ok){
    $("rank").innerHTML = '<tr><td style="padding:18px">' + (d.erro || "agregados em atualização") + ' — <a href="#" onclick="iniciar();return false" style="color:#0071e3">tentar de novo</a></td></tr>';
    return;
  }
  AGG = d;
  $("conf-base").textContent = fmt(d.total) + " empresas de serviço em SP (" + (d.competencia || "") + ")";
  renderAll();
}
function ticket(){ return parseFloat($("ticket").value) || 0; }
function renderAll(){
  if (!AGG) return;
  const f = AGG.flags || {};
  $("k-total").textContent = fmt(AGG.total);
  $("k-127").textContent = fmt(f.elegivel_127 || 0);
  $("k-128").textContent = fmt(f.elegivel_128 || 0);
  $("k-sim").textContent = fmt(f.decisao_simples || 0);
  const pot = ((f.elegivel_127 || 0) + (f.elegivel_128 || 0)) * ticket();
  $("k-pot").textContent = "R$ " + fmt(pot);
  const linhas = (AGG.top_cnaes || []).map(c => ({...c, pot: (c.eleg127 || 0) * ticket()}))
    .sort((a, b) => b.pot - a.pot).slice(0, 30);
  const max = Math.max(...linhas.map(c => c.pot), 1);
  $("rank").innerHTML = linhas.map(c => {
    const pct = Math.max(2, Math.round(c.pot / max * 100));
    const cor = c.eleg127 > 0 ? "#0d7a3f" : "#c3ccd9";
    return '<tr class="linha" onclick="drill(&quot;' + c.codigo + '&quot;, &quot;' + (c.descricao || "").replace(/"/g, "") + '&quot;)">'
      + "<td><b>" + c.codigo + "</b> " + (c.descricao || "—") + "</td>"
      + '<td class="td-num">' + fmt(c.n) + "</td>"
      + '<td class="td-num">' + fmt(c.eleg127) + "</td>"
      + '<td><div class="barra"><div style="width:' + pct + "%;background:" + cor + '"></div></div></td>'
      + '<td class="td-num"><b>R$ ' + fmt(c.pot) + "</b></td></tr>";
  }).join("");
  $("muns").innerHTML = (AGG.top_municipios || []).slice(0, 12).map(m =>
    '<tr><td>' + m.nome + '</td><td class="td-num">' + fmt(m.n) + '</td><td class="td-num" style="color:#86868b">' + fmt(m.simples) + " no Simples</td></tr>").join("");
  const NOMES_PORTE = {"01":"Microempresa (ME)","03":"Empresa de pequeno porte","05":"Demais portes","00":"não informado"};
  const portes = Object.entries(AGG.por_porte || {}).sort((a, b) => b[1].n - a[1].n);
  const tot = portes.reduce((s, [, d]) => s + d.n, 0) || 1;
  $("portes").innerHTML = portes.map(([cod, d]) => {
    const pct = Math.round(d.n / tot * 100);
    return "<tr><td>" + (NOMES_PORTE[cod] || cod) + '</td><td class="td-num">' + fmt(d.n) + '</td><td style="width:90px"><div class="barra"><div style="width:' + pct + '%;background:#0071e3"></div></div></td><td class="td-num">' + pct + "%</td></tr>";
  }).join("");
}
function mostra(v){
  $("dash").style.display = v === "dash" ? "block" : "none";
  $("drill").style.display = v === "drill" ? "block" : "none";
  $("ficha").style.display = v === "ficha" ? "block" : "none";
}
function voltarDash(){ mostra("dash"); }
async function drill(cnae, desc){
  mostra("drill");
  $("drill-titulo").textContent = desc || cnae;
  $("empresas").innerHTML = "<tr><td>carregando…</td></tr>";
  const r = await api("/api/radar/explorar?cnae=" + cnae + "&limit=100");
  const d = await r.json();
  $("drill-sub").textContent = "amostra de " + (d.itens || []).length + " empresas do CNAE " + cnae + " · clique para abrir a ficha";
  $("empresas").innerHTML = (d.itens || []).map(e =>
    '<tr class="linha" onclick="abrirCnpj(&quot;' + e.cnpj + '&quot;)">'
    + "<td>" + (e.razao_social || "—") + "</td><td>" + e.cnpj + "</td>"
    + "<td>" + (e.municipio_codigo || "") + "/" + (e.uf || "") + "</td>"
    + "<td>" + (e.simples === "S" ? '<span class="tag t-ambar">Simples</span>' : "—") + "</td>"
    + "<td>" + (e.data_inicio && e.data_inicio.length === 8 ? e.data_inicio.slice(6,8) + "/" + e.data_inicio.slice(4,6) + "/" + e.data_inicio.slice(0,4) : "—") + "</td></tr>").join("");
}
function consultar(){
  const bruto = $("cnpj").value.trim();
  if (!bruto){ msg("Digite um CNPJ para consultar"); return; }
  const norm = normalizarCnpjCli(bruto);
  if (!norm){ msg("CNPJ incompleto — são 14 caracteres"); $("cnpj").style.borderColor = "#d32f2f"; return; }
  if (!dvValidoC(norm)){ msg("Dígito verificador não confere — confira os números"); $("cnpj").style.borderColor = "#d32f2f"; return; }
  $("cnpj").style.borderColor = "#0d7a3f";
  msg("");
  abrirCnpj(norm);
}
async function abrirCnpj(cnpj){
  msg("consultando…");
  const r = await api("/api/radar/cnpj/" + encodeURIComponent(cnpj));
  const d = await r.json();
  msg("");
  if (!r.ok){ alert(d.erro || "CNPJ não encontrado"); return; }
  DADO = d;
  renderFicha();
}
const PILLS = {
  elegivel_127: ["p-verde", "Pode pagar 30% menos"],
  elegivel_128: ["p-verde", "Pode pagar até 60% menos"],
  decisao_simples: ["p-amarela", "Decisão obrigatória até set/2026"],
  cnae_suspeito: ["p-amarela", "CNAE para revisar"],
  cnae_mudou: ["p-cinza", "CNAE mudou recentemente"]
};
function renderFicha(){
  const d = DADO, ev = d.evidencias || {};
  mostra("ficha");
  $("f-nome").textContent = ev.razao_social || d.cnpj;
  $("f-sub").textContent = d.cnpj + (ev.matriz_filial === "2" ? " · filial" : "");
  $("f-cnae").textContent = (ev.cnae_principal || "—") + (ev.cnae_descricao ? " — " + ev.cnae_descricao : "");
  $("f-regime").textContent = ev.simples === "S" ? "Simples Nacional" : ev.simples === "N" ? "Regime normal" : "a confirmar";
  $("f-mun").textContent = ev.municipio ? ev.municipio + (ev.uf ? "/" + ev.uf : "") : (ev.municipio_codigo || "—");
  const ab = ev.data_inicio;
  $("f-abert").textContent = ab && ab.length === 8 ? ab.slice(6,8) + "/" + ab.slice(4,6) + "/" + ab.slice(0,4) : "—";
  const flags = d.encontrado ? (d.flags || []) : [];
  $("f-pills").innerHTML = d.encontrado
    ? (flags.length ? flags.filter(f => PILLS[f]).map(f => '<span class="pill ' + PILLS[f][0] + '">' + PILLS[f][1] + "</span>").join("")
                     : '<span class="pill p-cinza">Nenhum benefício identificado — veja o checklist</span>')
    : '<span class="pill p-cinza">CNPJ não localizado</span>';
  const ICON = {se_aplica: ["i-sim", "✓"], nao_se_aplica: ["i-nao", "✕"], verificar: ["i-ver", "?"]};
  $("regras").innerHTML = (d.regras || []).map(rg => {
    const [cls, ic] = ICON[rg.status] || ICON.verificar;
    return '<div class="regra"><div class="ico ' + cls + '">' + ic + "</div><div>"
      + '<div class="nome">' + rg.nome + "</div>"
      + '<div class="det">' + rg.detalhe + "</div></div></div>";
  }).join("");
  const tem = flags.includes("elegivel_127") || flags.includes("elegivel_128");
  $("card-eco").style.display = tem ? "block" : "none";
  calcEco();
  window.scrollTo({top: 0, behavior: "smooth"});
}
function calcEco(){
  const d = DADO; if (!d) return;
  const imp = parseFloat(($("imp-ano").value || "0").replace(/[^0-9.,]/g, "").replace(",", ".")) || 0;
  const taxa = (d.flags || []).includes("elegivel_128") ? 0.60 : (d.flags || []).includes("elegivel_127") ? 0.30 : 0;
  $("eco-n").textContent = "R$ " + Math.round(imp * taxa).toLocaleString("pt-BR");
  $("eco-l").textContent = taxa ? "potencial de economia por ano (redução de " + Math.round(taxa*100) + "%)" : "sem redução aplicável";
}
function copiarDelegacao(btn){
  const d = DADO, ev = (d && d.evidencias) || {};
  const pontos = (d.regras || []).filter(r => r.status !== "nao_se_aplica")
    .map(r => "- " + r.nome + ": " + r.detalhe).join("\\n");
  const txt = "Analisei o CNPJ " + d.cnpj + " (" + (ev.razao_social || "") + ") na reforma tributária (LC 214/2025) e preciso que você verifique com urgência:\\n\\n" + pontos
    + "\\n\\nMe retorne com o parecer e o plano de ação até o fim desta semana, por favor.";
  navigator.clipboard.writeText(txt).then(() => { btn.textContent = "✅ Copiada!"; setTimeout(() => btn.textContent = "📋 Copiar mensagem de cobrança", 1800); });
}
mascaraCnpjInput($("cnpj"));
$("cnpj").addEventListener("keydown", ev => { if (ev.key === "Enter") consultar(); });
iniciar();
</script></body></html>`;


const APP_HTML = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Reforma tributária no seu negócio — serviços em SP</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500;12..96,700;12..96,800&family=Public+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
:root{
  --bg:#EDF1EF; --paper:#FFFFFF; --ink:#16302A; --muted:#566B65; --line:#CCD7D3;
  --good:#24724F; --good-bg:#DCEFE5; --warn:#A86F00; --warn-bg:#FBEFCF; --risk:#A63C2A; --risk-bg:#F7E0DA;
  --brand:#1F4D43; --brand-ink:#FFFFFF; --soft:#E3EAE7;
  --display:"Bricolage Grotesque", "Segoe UI", system-ui, sans-serif;
  --body:"Public Sans", "Segoe UI", system-ui, -apple-system, sans-serif;
  box-sizing:border-box; padding-top:env(safe-area-inset-top,0px); padding-bottom:env(safe-area-inset-bottom,0px);
}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){
  --bg:#0F1C19; --paper:#16272300; --paper:#172824; --ink:#E6EFEC; --muted:#9DB2AC; --line:#2C4540;
  --good:#6FCF9F; --good-bg:#183A2C; --warn:#F2C25A; --warn-bg:#3A2F12; --risk:#F09A85; --risk-bg:#3E211B;
  --brand:#8FD3BC; --brand-ink:#0F1C19; --soft:#1F3530;}}
:root[data-theme="dark"]{
  --bg:#0F1C19; --paper:#172824; --ink:#E6EFEC; --muted:#9DB2AC; --line:#2C4540;
  --good:#6FCF9F; --good-bg:#183A2C; --warn:#F2C25A; --warn-bg:#3A2F12; --risk:#F09A85; --risk-bg:#3E211B;
  --brand:#8FD3BC; --brand-ink:#0F1C19; --soft:#1F3530;}
*,*::before,*::after{box-sizing:inherit}
html{scroll-padding-top:env(safe-area-inset-top,0px)}
body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--body);font-size:16px;line-height:1.55;-webkit-font-smoothing:antialiased}
.wrap{max-width:1120px;margin:0 auto;padding:0 20px}
h1,h2,h3{font-family:var(--display);line-height:1.08;margin:0;letter-spacing:-.015em}
h2{font-size:clamp(1.5rem,3vw,2.1rem);font-weight:700}
h3{font-size:1.15rem;font-weight:700}
p{margin:0}
.muted{color:var(--muted)}
a{color:var(--brand)}
:focus-visible{outline:3px solid var(--warn);outline-offset:2px;border-radius:4px}

/* hero */
header.hero{background:var(--brand);color:var(--brand-ink);padding:56px 0 120px}
.topline{display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap;font-size:.9rem;opacity:.85;margin-bottom:40px}
.hero h1{font-size:clamp(2.2rem,6vw,4.4rem);font-weight:800;max-width:15ch}
.hero .lede{font-size:1.15rem;max-width:58ch;margin-top:18px;opacity:.92}
.picker{margin-top:-84px;background:var(--paper);border-radius:20px;padding:28px;box-shadow:0 18px 40px -24px rgba(10,40,30,.45);border:1px solid var(--line)}
.picker-row{display:grid;grid-template-columns:2fr 1fr;gap:16px}
label.f{display:block;font-weight:600;font-size:.95rem;margin-bottom:6px}
.combo{position:relative}
input[type=search],select,input[type=number]{width:100%;font:inherit;font-size:1.05rem;padding:14px 16px;border-radius:12px;border:1.5px solid var(--line);background:var(--bg);color:var(--ink)}
input:focus,select:focus{border-color:var(--brand);outline:none;box-shadow:0 0 0 3px color-mix(in srgb,var(--brand) 25%,transparent)}
.list{position:absolute;z-index:5;left:0;right:0;top:calc(100% + 6px);background:var(--paper);border:1px solid var(--line);border-radius:12px;max-height:320px;overflow:auto;box-shadow:0 14px 30px -18px rgba(0,0,0,.4);display:none}
.list.open{display:block}
.opt{padding:10px 14px;cursor:pointer;display:flex;justify-content:space-between;gap:12px;font-size:.95rem}
.opt small{color:var(--muted);white-space:nowrap}
.opt[aria-selected=true],.opt:hover{background:var(--soft)}
.hint{font-size:.85rem;color:var(--muted);margin-top:8px}

/* verdict */
.verdict{margin-top:28px;display:grid;grid-template-columns:1.1fr 1fr;gap:28px;align-items:start}
.verdict .lead{font-family:var(--display);font-size:clamp(1.35rem,2.6vw,1.9rem);font-weight:700;line-height:1.2}
.verdict .lead b{font-weight:800}
.peer{margin-top:14px;color:var(--muted)}
.answers{display:grid;gap:10px}
.ans{display:grid;grid-template-columns:auto 1fr;gap:12px;padding:14px 16px;border-radius:14px;align-items:start}
.ans .dot{width:30px;height:30px;border-radius:50%;display:grid;place-items:center;font-weight:800;font-size:.95rem}
.ans.good{background:var(--good-bg)} .ans.good .dot{background:var(--good);color:var(--paper)}
.ans.warn{background:var(--warn-bg)} .ans.warn .dot{background:var(--warn);color:var(--paper)}
.ans.risk{background:var(--risk-bg)} .ans.risk .dot{background:var(--risk);color:var(--paper)}
.ans.neutral{background:var(--soft)} .ans.neutral .dot{background:var(--muted);color:var(--paper)}
.ans h3{font-size:1rem;font-family:var(--body);font-weight:700}
.ans p{font-size:.92rem;margin-top:2px}

section{padding:64px 0 0}
.sec-head{display:flex;justify-content:space-between;align-items:end;gap:20px;flex-wrap:wrap;margin-bottom:24px}
.sec-head p{max-width:56ch}

/* simulator */
.sim{display:grid;grid-template-columns:1fr 1.3fr;gap:28px;background:var(--paper);border:1px solid var(--line);border-radius:20px;padding:28px}
.fields{display:grid;gap:16px}
.seg{display:flex;gap:6px;flex-wrap:wrap}
.seg button{font:inherit;font-size:.92rem;padding:9px 14px;border-radius:999px;border:1.5px solid var(--line);background:var(--bg);color:var(--ink);cursor:pointer}
.seg button[aria-pressed=true]{background:var(--brand);border-color:var(--brand);color:var(--brand-ink)}
.bars{display:grid;gap:18px;align-content:start}
.bar-label{display:flex;justify-content:space-between;font-size:.95rem;margin-bottom:6px}
.bar-label strong{font-family:var(--display);font-size:1.25rem}
.track{height:22px;background:var(--soft);border-radius:6px;overflow:hidden}
.fill{height:100%;border-radius:6px;transition:width .45s cubic-bezier(.2,.7,.2,1)}
.save{margin-top:6px;padding:16px;border-radius:14px;background:var(--good-bg)}
.save strong{font-family:var(--display);font-size:1.8rem;display:block;color:var(--good)}
.fine{font-size:.82rem;color:var(--muted);margin-top:12px}

/* panorama */
.pano{display:grid;grid-template-columns:repeat(4,1fr);border-top:2px solid var(--ink)}
.pano > div{padding:20px 18px 20px 0;border-right:1px solid var(--line)}
.pano > div + div{padding-left:18px}
.pano > div:last-child{border-right:0}
.pano .num{font-family:var(--display);font-size:clamp(1.8rem,3.4vw,2.6rem);font-weight:800;line-height:1}
.pano .pct{font-weight:700;margin:6px 0 8px}
.pano p.d{font-size:.92rem;color:var(--muted)}
.c-good{color:var(--good)} .c-warn{color:var(--warn)} .c-risk{color:var(--risk)}

/* porte */
.porte{display:grid;gap:18px;background:var(--paper);border:1px solid var(--line);border-radius:20px;padding:28px}
.prow{display:grid;grid-template-columns:200px 1fr 110px;gap:16px;align-items:center}
.stack{display:flex;height:30px;border-radius:7px;overflow:hidden;background:var(--soft)}
.stack span{height:100%}
.legend{display:flex;gap:18px;flex-wrap:wrap;font-size:.88rem;color:var(--muted)}
.legend i{display:inline-block;width:12px;height:12px;border-radius:3px;margin-right:6px;vertical-align:-1px}

/* tables */
.twocol{display:grid;grid-template-columns:1fr 1fr;gap:28px}
.panel{background:var(--paper);border:1px solid var(--line);border-radius:20px;padding:24px;min-width:0}
.scroll{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:.92rem}
th{text-align:left;font-weight:600;color:var(--muted);padding:8px 8px;border-bottom:1.5px solid var(--line);white-space:nowrap}
td{padding:9px 8px;border-bottom:1px solid var(--line);vertical-align:top}
td.n,th.n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
tr.clickable{cursor:pointer}
tr.clickable:hover td{background:var(--soft)}
.chip{display:inline-block;font-size:.76rem;font-weight:700;padding:2px 8px;border-radius:999px;white-space:nowrap}
.chip.g{background:var(--good-bg);color:var(--good)} .chip.w{background:var(--warn-bg);color:var(--warn)}

/* steps */
ol.steps{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(4,1fr);gap:0;counter-reset:s;border-top:2px solid var(--ink)}
ol.steps li{counter-increment:s;padding:22px 20px 0 0}
ol.steps li::before{content:counter(s);font-family:var(--display);font-weight:800;font-size:2.4rem;color:var(--brand);display:block;line-height:1;margin-bottom:10px}
ol.steps li p{font-size:.93rem;color:var(--muted);margin-top:6px}
.cta{margin-top:36px;display:flex;gap:20px;align-items:center;flex-wrap:wrap;background:var(--brand);color:var(--brand-ink);border-radius:20px;padding:28px}
.cta p{max-width:60ch}
.btn{display:inline-block;background:var(--brand-ink);color:var(--brand);font-weight:700;padding:13px 20px;border-radius:12px;text-decoration:none}
footer{padding:48px 0 40px;font-size:.85rem;color:var(--muted)}
footer p+p{margin-top:8px}

@media (max-width:900px){
  .picker-row,.verdict,.sim,.twocol{grid-template-columns:1fr}
  .pano{grid-template-columns:1fr 1fr}
  .pano > div:nth-child(2){border-right:0}
  .pano > div:nth-child(3){padding-left:0}
  .pano > div:nth-child(n+3){border-top:1px solid var(--line)}
  ol.steps{grid-template-columns:1fr 1fr}
  .prow{grid-template-columns:1fr;gap:6px}
}
@media (max-width:520px){.pano,ol.steps{grid-template-columns:1fr}.pano > div{border-right:0;padding-left:0!important;border-top:1px solid var(--line)}.picker,.sim,.porte,.panel{padding:20px}}
@media (prefers-reduced-motion:reduce){.fill{transition:none}}
</style>
</head>
<body>
<nav style="position:sticky;top:0;z-index:50;background:var(--paper);border-bottom:1px solid var(--line);padding:10px 18px;display:flex;gap:16px;align-items:center;font-family:var(--body);font-size:13px">
  <strong style="color:var(--brand)">Radar da Reforma</strong>
  <a href="/app" style="color:var(--ink);text-decoration:none;font-weight:600">Mapa</a>
  <a href="/dash" style="color:var(--ink);text-decoration:none">Consultar CNPJ</a>
  <a href="/pro" style="color:var(--ink);text-decoration:none">Subir carteira</a>
</nav>
<header class="hero">
  <div class="wrap">
    <div class="topline"><span>Radar da Reforma · serviços no estado de São Paulo</span><span id="comp"></span></div>
    <h1>O que a reforma tributária muda no seu negócio</h1>
    <p class="lede">Escolha o seu ramo e veja, com base nos dados da Receita Federal, se ele tem redução de imposto, quantas empresas iguais à sua existem em SP e o que você precisa decidir.</p>
  </div>
</header>

<main class="wrap">
  <div class="picker" aria-live="polite">
    <div class="picker-row">
      <div>
        <label class="f" for="q">Qual é o seu ramo de atividade?</label>
        <div class="combo">
          <input id="q" type="search" autocomplete="off" placeholder="Ex.: advocacia, contabilidade, salão, transporte…" role="combobox" aria-expanded="false" aria-controls="lst" aria-autocomplete="list">
          <div class="list" id="lst" role="listbox"></div>
        </div>
        <p class="hint">Os 100 ramos com mais empresas em SP. Não achou o seu? Consulte pelo CNPJ no fim da página.</p>
      </div>
      <div>
        <label class="f" for="city">Sua cidade</label>
        <select id="city"></select>
      </div>
    </div>

    <div class="verdict">
      <div>
        <p class="lead" id="lead"></p>
        <p class="peer" id="peer"></p>
      </div>
      <div class="answers" id="answers"></div>
    </div>
  </div>

  <section id="sim-sec">
    <div class="sec-head">
      <h2>Quanto isso pode pesar no caixa</h2>
      <p class="muted">Ordem de grandeza do novo imposto sobre serviços (IBS + CBS) para o seu faturamento. A alíquota final ainda não foi fixada — ajuste o valor de referência se o seu contador tiver outro número.</p>
    </div>
    <div class="sim">
      <div class="fields">
        <div>
          <label class="f" for="fat">Faturamento mensal (R$)</label>
          <input id="fat" type="number" min="0" step="1000" value="80000" inputmode="numeric">
        </div>
        <div>
          <label class="f" for="rate">Alíquota de referência IBS + CBS (%)</label>
          <input id="rate" type="number" min="0" max="40" step="0.1" value="26.5" inputmode="decimal">
        </div>
        <div>
          <span class="f" id="redlab">Redução que se aplica ao seu ramo</span>
          <div class="seg" role="group" aria-labelledby="redlab" id="redseg">
            <button type="button" data-r="0">Nenhuma</button>
            <button type="button" data-r="30">30% (profissão regulamentada)</button>
            <button type="button" data-r="60">60% (saúde, educação, cultura)</button>
          </div>
          <p class="hint" id="redhint"></p>
        </div>
      </div>
      <div class="bars">
        <div>
          <div class="bar-label"><span>Sem redução</span><strong id="v0"></strong></div>
          <div class="track"><div class="fill" id="b0" style="background:var(--muted)"></div></div>
        </div>
        <div>
          <div class="bar-label"><span>Com a redução do seu ramo</span><strong id="v1"></strong></div>
          <div class="track"><div class="fill" id="b1" style="background:var(--good)"></div></div>
        </div>
        <div class="save"><span>Diferença por ano</span><strong id="v2"></strong></div>
        <p class="fine">Cálculo simplificado: faturamento × alíquota × (1 − redução). Não considera créditos de insumos, a transição gradual 2026–2033 nem o regime do Simples, que muda a conta. Use para conversar com o contador, não para decidir sozinho.</p>
      </div>
    </div>
  </section>

  <section>
    <div class="sec-head">
      <h2>O retrato dos serviços em SP</h2>
      <p class="muted" id="pano-sub"></p>
    </div>
    <div class="pano" id="pano"></div>
  </section>

  <section>
    <div class="sec-head">
      <h2>Por tamanho de empresa</h2>
      <p class="muted">Quanto menor a empresa, mais ela depende do Simples — e mais pesa a decisão de ficar dentro ou fora dele no novo sistema.</p>
    </div>
    <div class="porte">
      <div class="legend"><span><i style="background:var(--warn)"></i>MEI</span><span><i style="background:color-mix(in srgb,var(--warn) 45%,var(--paper))"></i>Simples (sem MEI)</span><span><i style="background:var(--soft);border:1px solid var(--line)"></i>Fora do Simples</span></div>
      <div id="porte"></div>
    </div>
  </section>

  <section>
    <div class="sec-head">
      <h2>Onde estão os ramos com redução</h2>
      <p class="muted">Clique numa linha para ver o ramo no topo da página.</p>
    </div>
    <div class="twocol">
      <div class="panel">
        <h3>Ramos com redução de imposto</h3>
        <p class="muted" style="font-size:.9rem;margin:4px 0 14px">Os 12 maiores entre os 100 ramos mais populosos de SP. * só se for ensino regular.</p>
        <div class="scroll"><table id="t-benef"><thead><tr><th>Ramo</th><th>Redução</th><th class="n">Empresas</th></tr></thead><tbody></tbody></table></div>
      </div>
      <div class="panel">
        <h3>Cidades com mais profissionais regulamentados</h3>
        <p class="muted" style="font-size:.9rem;margin:4px 0 14px">Empresas com direito à redução de 30%.</p>
        <div class="scroll"><table id="t-city"><thead><tr><th>Cidade</th><th class="n">Com redução 30%</th><th class="n">% da cidade</th></tr></thead><tbody></tbody></table></div>
      </div>
    </div>
  </section>

  <section>
    <div class="sec-head"><h2>O que fazer agora</h2></div>
    <ol class="steps">
      <li><h3>Confira o seu CNAE</h3><p>É o código da atividade no cartão CNPJ. É ele que define se você tem redução. Atividade principal errada pode custar o benefício.</p></li>
      <li><h3>Decida sobre o Simples</h3><p>Optantes escolhem recolher IBS/CBS dentro ou fora do DAS. Fora, você gera crédito para clientes empresas; dentro, paga menos burocracia.</p></li>
      <li><h3>Ajuste sua emissão de notas</h3><p>A nota fiscal de serviço passa a destacar IBS e CBS. Fale com quem emite suas notas e teste o sistema.</p></li>
      <li><h3>Revise preços e contratos</h3><p>Com o pagamento dividido automático (split payment), o imposto sai na hora da venda. Isso muda o seu caixa e os contratos longos.</p></li>
    </ol>
    <div class="cta">
      <p><strong>Quer a ficha da sua empresa?</strong> Digite o seu CNPJ no Radar e veja as 8 regras aplicadas ao seu caso: redução, Simples, nota fiscal, coerência do CNAE e mais.</p>
      <a class="btn" href="/dash" target="_blank" rel="noopener">Consultar meu CNPJ</a>
    </div>
  </section>
</main>

<footer class="wrap">
  <p id="foot"></p>
  <p>Regras: LC 214/2025 (arts. 126–130) com alterações da LC 227/2026. Redução de 60% por ramo é indicativa (saúde, educação regular, cultura e jornalismo); educação exige verificar se é ensino regular. Material informativo, não substitui orientação contábil ou jurídica.</p>
</footer>

<script>
const D = window.__AGG__ || {"build_id":"2026-09-SP-c64c3319-fix1","competencia":"2026-09","total":5775684,"flags":{"elegivel_127":205582,"elegivel_128":537066,"decisao_simples":4285145,"cnae_suspeito":104042},"por_porte":{"01":{"n":4638176,"simples":3989631,"mei":2727508,"eleg127":121706},"05":{"n":775622,"simples":77178,"mei":3,"eleg127":62712},"03":{"n":361886,"simples":218336,"mei":13,"eleg127":21164}},"top_cnaes":[{"codigo":"8219999","descricao":"Preparação de documentos e serviços especializados de apoio administrativo não especificados anteriormente","n":287405,"simples":264070,"mei":202677,"eleg127":0},{"codigo":"9602501","descricao":"Cabeleireiros, manicure e pedicure","n":277641,"simples":247565,"mei":238543,"eleg127":0},{"codigo":"7319002","descricao":"Promoção de vendas","n":253126,"simples":229337,"mei":192841,"eleg127":0},{"codigo":"4930201","descricao":"Transporte rodoviário de carga, exceto produtos perigosos e mudanças, municipal.","n":188695,"simples":165126,"mei":158496,"eleg127":0},{"codigo":"8211300","descricao":"Serviços combinados de escritório e apoio administrativo","n":150450,"simples":116238,"mei":5,"eleg127":0},{"codigo":"4930202","descricao":"Transporte rodoviário de carga, exceto produtos perigosos e mudanças, intermunicipal, interestadual e internacional","n":138815,"simples":109011,"mei":83028,"eleg127":0},{"codigo":"5611203","descricao":"Lanchonetes, casas de chá, de sucos e similares","n":129257,"simples":102628,"mei":65143,"eleg127":0},{"codigo":"5320202","descricao":"Serviços de entrega rápida","n":122090,"simples":110045,"mei":109681,"eleg127":0},{"codigo":"5620104","descricao":"Fornecimento de alimentos preparados preponderantemente para consumo domiciliar","n":121954,"simples":107414,"mei":97775,"eleg127":0},{"codigo":"8599699","descricao":"Outras atividades de ensino não especificadas anteriormente","n":115758,"simples":107696,"mei":98799,"eleg127":0},{"codigo":"5320201","descricao":"Serviços de malote não realizados pelo Correio Nacional","n":112410,"simples":106954,"mei":107443,"eleg127":0},{"codigo":"9602502","descricao":"Atividades de estética e outros serviços de cuidados com a beleza","n":112256,"simples":99516,"mei":88108,"eleg127":0},{"codigo":"8599604","descricao":"Treinamento em desenvolvimento profissional e gerencial","n":108249,"simples":95043,"mei":53648,"eleg127":0},{"codigo":"5611201","descricao":"Restaurantes e similares","n":106251,"simples":81655,"mei":49233,"eleg127":0},{"codigo":"4923002","descricao":"Serviço de transporte de passageiros - locação de automóveis com motorista","n":98890,"simples":96020,"mei":96643,"eleg127":0},{"codigo":"8230001","descricao":"Serviços de organização de feiras, congressos, exposições e festas","n":91993,"simples":79023,"mei":60783,"eleg127":0},{"codigo":"8112500","descricao":"Condomínios prediais","n":84853,"simples":0,"mei":0,"eleg127":0},{"codigo":"8630503","descricao":"Atividade médica ambulatorial restrita a consultas","n":71024,"simples":37438,"mei":0,"eleg127":0},{"codigo":"6462000","descricao":"Holdings de instituições não-financeiras","n":68996,"simples":1,"mei":0,"eleg127":0},{"codigo":"7020400","descricao":"Atividades de consultoria em gestão empresarial, exceto consultoria técnica específica","n":67676,"simples":38150,"mei":3,"eleg127":0},{"codigo":"5612100","descricao":"Serviços ambulantes de alimentação","n":66222,"simples":59914,"mei":57918,"eleg127":0},{"codigo":"8712300","descricao":"Atividades de fornecimento de infra-estrutura de apoio e assistência a paciente no domicílio","n":60659,"simples":55561,"mei":55308,"eleg127":0},{"codigo":"9511800","descricao":"Reparação e manutenção de computadores e de equipamentos periféricos","n":55913,"simples":50039,"mei":39013,"eleg127":0},{"codigo":"6911701","descricao":"Serviços advocatícios","n":55907,"simples":46831,"mei":0,"eleg127":55907},{"codigo":"9491000","descricao":"Atividades de organizações religiosas ou filosóficas","n":54901,"simples":1,"mei":0,"eleg127":0},{"codigo":"7112000","descricao":"Serviços de engenharia","n":45435,"simples":29493,"mei":1,"eleg127":45435},{"codigo":"5912099","descricao":"Atividades de pós-produção cinematográfica, de vídeos e de programas de televisão não especificadas anteriormente","n":44379,"simples":41588,"mei":35794,"eleg127":0},{"codigo":"4781400","descricao":"Comércio varejista de artigos do vestuário e acessórios","n":44327,"simples":36920,"mei":27240,"eleg127":0},{"codigo":"8650003","descricao":"Atividades de psicologia e psicanálise","n":43087,"simples":37015,"mei":0,"eleg127":0},{"codigo":"9430800","descricao":"Atividades de associações de defesa de direitos sociais","n":42181,"simples":1,"mei":0,"eleg127":0},{"codigo":"6209100","descricao":"Suporte técnico, manutenção e outros serviços em tecnologia da informação","n":41097,"simples":32193,"mei":0,"eleg127":0},{"codigo":"6204000","descricao":"Consultoria em tecnologia da informação","n":36937,"simples":26954,"mei":1,"eleg127":0},{"codigo":"8630504","descricao":"Atividade odontológica","n":33669,"simples":25438,"mei":0,"eleg127":0},{"codigo":"5611204","descricao":"Bares e outros estabelecimentos especializados em servir bebidas, sem entretenimento","n":33631,"simples":28599,"mei":22461,"eleg127":0},{"codigo":"7420001","descricao":"Atividades de produção de fotografias, exceto aérea e submarina","n":32667,"simples":29516,"mei":24727,"eleg127":0},{"codigo":"4321500","descricao":"Instalação e manutenção elétrica","n":32007,"simples":26310,"mei":19242,"eleg127":0},{"codigo":"5819100","descricao":"Edição de cadastros, listas e de outros produtos gráficos","n":31938,"simples":29785,"mei":26559,"eleg127":0},{"codigo":"6821801","descricao":"Corretagem na compra e venda e avaliação de imóveis","n":31672,"simples":24885,"mei":1,"eleg127":0},{"codigo":"6810202","descricao":"Aluguel de imóveis próprios","n":31080,"simples":18,"mei":0,"eleg127":0},{"codigo":"6622300","descricao":"Corretores e agentes de seguros, de planos de previdência complementar e de saúde","n":30254,"simples":23180,"mei":2,"eleg127":0},{"codigo":"6920601","descricao":"Atividades de contabilidade","n":30120,"simples":24205,"mei":1,"eleg127":30120},{"codigo":"6810201","descricao":"Compra e venda de imóveis próprios","n":29718,"simples":1691,"mei":0,"eleg127":0},{"codigo":"8130300","descricao":"Atividades paisagísticas","n":29712,"simples":26225,"mei":23234,"eleg127":0},{"codigo":"6201501","descricao":"Desenvolvimento de programas de computador sob encomenda","n":29434,"simples":21426,"mei":0,"eleg127":0},{"codigo":"4712100","descricao":"Comércio varejista de mercadorias em geral, com predominância de produtos alimentícios - minimercados, mercearias e armazéns","n":28654,"simples":21438,"mei":10301,"eleg127":0},{"codigo":"7490104","descricao":"Atividades de intermediação e agenciamento de serviços e negócios em geral, exceto imobiliários","n":28048,"simples":15675,"mei":0,"eleg127":0},{"codigo":"8299799","descricao":"Outras atividades de serviços prestados principalmente às empresas não especificadas anteriormente","n":28025,"simples":18415,"mei":3978,"eleg127":0},{"codigo":"8291100","descricao":"Atividades de cobranças e informações cadastrais","n":27894,"simples":21288,"mei":11936,"eleg127":0},{"codigo":"9001902","descricao":"Produção musical","n":27421,"simples":24616,"mei":20880,"eleg127":0},{"codigo":"7911200","descricao":"Agências de viagens","n":27078,"simples":23412,"mei":14570,"eleg127":0},{"codigo":"4723700","descricao":"Comércio varejista de bebidas","n":26663,"simples":22248,"mei":16706,"eleg127":0},{"codigo":"1091102","descricao":"Fabricação de produtos de padaria e confeitaria com predominância de produção própria","n":25661,"simples":22721,"mei":20274,"eleg127":0},{"codigo":"6470101","descricao":"Fundos de investimento, exceto previdenciários e imobiliários","n":24829,"simples":0,"mei":0,"eleg127":0},{"codigo":"8592999","descricao":"Ensino de arte e cultura não especificado anteriormente","n":24200,"simples":22225,"mei":20993,"eleg127":0},{"codigo":"9609208","descricao":"Higiene e embelezamento de animais domésticos","n":23622,"simples":21298,"mei":18620,"eleg127":0},{"codigo":"4110700","descricao":"Incorporação de empreendimentos imobiliários","n":22538,"simples":1,"mei":1,"eleg127":0},{"codigo":"4751201","descricao":"Comércio varejista especializado de equipamentos e suprimentos de informática","n":22128,"simples":17234,"mei":7324,"eleg127":0},{"codigo":"4399103","descricao":"Obras de alvenaria","n":21279,"simples":17434,"mei":13987,"eleg127":0},{"codigo":"7319003","descricao":"Marketing direto","n":21090,"simples":16665,"mei":0,"eleg127":0},{"codigo":"4729699","descricao":"Comércio varejista de produtos alimentícios em geral ou especializado em produtos alimentícios não especificados anteriormente","n":21043,"simples":16675,"mei":8665,"eleg127":0},{"codigo":"9313100","descricao":"Atividades de condicionamento físico","n":20940,"simples":16794,"mei":1,"eleg127":20940},{"codigo":"8650004","descricao":"Atividades de fisioterapia","n":20504,"simples":17259,"mei":0,"eleg127":0},{"codigo":"8599603","descricao":"Treinamento em informática","n":19041,"simples":17535,"mei":12594,"eleg127":0},{"codigo":"5212500","descricao":"Carga e descarga","n":19011,"simples":17275,"mei":16460,"eleg127":0},{"codigo":"4120400","descricao":"Construção de edifícios","n":19007,"simples":7551,"mei":0,"eleg127":0},{"codigo":"9492800","descricao":"Atividades de organizações políticas","n":18972,"simples":0,"mei":0,"eleg127":0},{"codigo":"5611205","descricao":"Bares e outros estabelecimentos especializados em servir bebidas, com entretenimento","n":18924,"simples":16192,"mei":13926,"eleg127":0},{"codigo":"5620101","descricao":"Fornecimento de alimentos preparados preponderantemente para empresas","n":18892,"simples":12729,"mei":10683,"eleg127":0},{"codigo":"4772500","descricao":"Comércio varejista de cosméticos, produtos de perfumaria e de higiene pessoal","n":18699,"simples":14411,"mei":9576,"eleg127":0},{"codigo":"4789099","descricao":"Comércio varejista de outros produtos não especificados anteriormente","n":18530,"simples":14477,"mei":5823,"eleg127":0},{"codigo":"9499500","descricao":"Atividades associativas não especificadas anteriormente","n":18243,"simples":0,"mei":0,"eleg127":0},{"codigo":"6463800","descricao":"Outras sociedades de participação, exceto holdings","n":16872,"simples":2,"mei":0,"eleg127":0},{"codigo":"7500100","descricao":"Atividades veterinárias","n":16786,"simples":14402,"mei":1,"eleg127":16786},{"codigo":"4924800","descricao":"Transporte escolar","n":16717,"simples":14841,"mei":11419,"eleg127":0},{"codigo":"5223100","descricao":"Estacionamento de veículos","n":16619,"simples":11397,"mei":3893,"eleg127":0},{"codigo":"6822600","descricao":"Gestão e administração da propriedade imobiliária","n":16400,"simples":7413,"mei":0,"eleg127":0},{"codigo":"9512600","descricao":"Reparação e manutenção de equipamentos de comunicação","n":16189,"simples":13650,"mei":11550,"eleg127":0},{"codigo":"5620102","descricao":"Serviços de alimentação para eventos e recepções - bufê","n":15888,"simples":13356,"mei":9936,"eleg127":0},{"codigo":"8630599","descricao":"Atividades de atenção ambulatorial não especificadas anteriormente","n":15488,"simples":11658,"mei":0,"eleg127":0},{"codigo":"6202300","descricao":"Desenvolvimento e licenciamento de programas de computador customizáveis","n":15317,"simples":10646,"mei":0,"eleg127":0},{"codigo":"7111100","descricao":"Serviços de arquitetura","n":15220,"simples":11550,"mei":0,"eleg127":15220},{"codigo":"8593700","descricao":"Ensino de idiomas","n":13932,"simples":12369,"mei":8398,"eleg127":0},{"codigo":"4752100","descricao":"Comércio varejista especializado de equipamentos de telefonia e comunicação","n":13882,"simples":10331,"mei":4576,"eleg127":0},{"codigo":"4929901","descricao":"Transporte rodoviário coletivo de passageiros, sob regime de fretamento, municipal","n":13820,"simples":10642,"mei":9647,"eleg127":0},{"codigo":"4789004","descricao":"Comércio varejista de animais vivos e de artigos e alimentos para animais de estimação","n":13749,"simples":11119,"mei":5497,"eleg127":0},{"codigo":"9700500","descricao":"Serviços domésticos","n":13641,"simples":12887,"mei":12961,"eleg127":0},{"codigo":"9609299","descricao":"Outras atividades de serviços pessoais não especificadas anteriormente","n":13544,"simples":11850,"mei":9945,"eleg127":0},{"codigo":"9521500","descricao":"Reparação e manutenção de equipamentos eletroeletrônicos de uso pessoal e doméstico","n":13382,"simples":11264,"mei":8565,"eleg127":0},{"codigo":"5811500","descricao":"Edição de livros","n":13325,"simples":11321,"mei":8038,"eleg127":0},{"codigo":"5911199","descricao":"Atividades de produção cinematográfica, de vídeos e de programas de televisão não especificadas anteriormente","n":12539,"simples":10115,"mei":1,"eleg127":0},{"codigo":"7311400","descricao":"Agências de publicidade","n":12327,"simples":7713,"mei":1,"eleg127":0},{"codigo":"4511102","descricao":"Comércio a varejo de automóveis, camionetas e utilitários usados","n":11752,"simples":2531,"mei":0,"eleg127":0},{"codigo":"6311900","descricao":"Tratamento de dados, provedores de serviços de aplicação e serviços de hospedagem na internet","n":11743,"simples":7718,"mei":0,"eleg127":0},{"codigo":"4923001","descricao":"Serviço de táxi","n":11694,"simples":10579,"mei":10346,"eleg127":0},{"codigo":"9001906","descricao":"Atividades de sonorização e de iluminação","n":11653,"simples":10309,"mei":8711,"eleg127":0},{"codigo":"6190699","descricao":"Outras atividades de telecomunicações não especificadas anteriormente","n":11499,"simples":10023,"mei":8428,"eleg127":0},{"codigo":"6319400","descricao":"Portais, provedores de conteúdo e outros serviços de informação na internet","n":11345,"simples":8304,"mei":1,"eleg127":0},{"codigo":"4930204","descricao":"Transporte rodoviário de mudanças","n":11197,"simples":10011,"mei":9530,"eleg127":0},{"codigo":"9609206","descricao":"Serviços de tatuagem e colocação de piercing","n":11039,"simples":9670,"mei":9191,"eleg127":0},{"codigo":"8610102","descricao":"Atividades de atendimento em pronto-socorro e unidades hospitalares para atendimento a urgências","n":10402,"simples":6298,"mei":0,"eleg127":0}],"top_municipios":[{"codigo":"7107","nome":"SAO PAULO","n":2087553,"simples":1497333,"mei":817020,"eleg127":84493},{"codigo":"6291","nome":"CAMPINAS","n":179903,"simples":134275,"mei":82318,"eleg127":7415},{"codigo":"6477","nome":"GUARULHOS","n":149971,"simples":113536,"mei":87725,"eleg127":3607},{"codigo":"6969","nome":"RIBEIRAO PRETO","n":117448,"simples":84671,"mei":52260,"eleg127":4851},{"codigo":"7075","nome":"SAO BERNARDO DO CAMPO","n":101701,"simples":77360,"mei":48597,"eleg127":3746},{"codigo":"7145","nome":"SOROCABA","n":101692,"simples":77981,"mei":51472,"eleg127":3551},{"codigo":"7057","nome":"SANTO ANDRE","n":97000,"simples":74698,"mei":45820,"eleg127":3870},{"codigo":"7099","nome":"SAO JOSE DOS CAMPOS","n":95226,"simples":72995,"mei":47329,"eleg127":3760},{"codigo":"6789","nome":"OSASCO","n":91613,"simples":68263,"mei":49013,"eleg127":2301},{"codigo":"7097","nome":"SAO JOSE DO RIO PRETO","n":76497,"simples":55055,"mei":34625,"eleg127":2970},{"codigo":"7071","nome":"SANTOS","n":70865,"simples":48516,"mei":30360,"eleg127":3037},{"codigo":"6619","nome":"JUNDIAI","n":70087,"simples":53410,"mei":31453,"eleg127":2865},{"codigo":"6213","nome":"BARUERI","n":69638,"simples":41639,"mei":22329,"eleg127":2943},{"codigo":"6713","nome":"MOGI DAS CRUZES","n":52442,"simples":39852,"mei":27469,"eleg127":1959},{"codigo":"6219","nome":"BAURU","n":51624,"simples":39561,"mei":27926,"eleg127":1828},{"codigo":"6875","nome":"PIRACICABA","n":48376,"simples":37223,"mei":24504,"eleg127":1894},{"codigo":"6921","nome":"PRAIA GRANDE","n":44884,"simples":34096,"mei":28210,"eleg127":832},{"codigo":"6425","nome":"FRANCA","n":40384,"simples":31249,"mei":19704,"eleg127":1270},{"codigo":"6361","nome":"COTIA","n":37257,"simples":28005,"mei":18810,"eleg127":1303},{"codigo":"6377","nome":"DIADEMA","n":36950,"simples":29649,"mei":23487,"eleg127":803},{"codigo":"6511","nome":"INDAIATUBA","n":36857,"simples":24792,"mei":17029,"eleg127":1293},{"codigo":"6313","nome":"CARAPICUIBA","n":36128,"simples":29789,"mei":24099,"eleg127":583},{"codigo":"6639","nome":"LIMEIRA","n":35506,"simples":27760,"mei":19542,"eleg127":1093},{"codigo":"7183","nome":"TAUBATE","n":35451,"simples":27403,"mei":19662,"eleg127":1345},{"codigo":"7121","nome":"SAO VICENTE","n":33723,"simples":27818,"mei":24233,"eleg127":487},{"codigo":"7079","nome":"SAO CARLOS","n":32788,"simples":24264,"mei":15588,"eleg127":1330},{"codigo":"6689","nome":"MAUA","n":32728,"simples":26540,"mei":21229,"eleg127":710},{"codigo":"7077","nome":"SAO CAETANO DO SUL","n":32436,"simples":22862,"mei":10886,"eleg127":1551},{"codigo":"6131","nome":"AMERICANA","n":32346,"simples":23696,"mei":14591,"eleg127":1290},{"codigo":"6475","nome":"GUARUJA","n":31839,"simples":24342,"mei":20035,"eleg127":634},{"codigo":"7151","nome":"SUZANO","n":30690,"simples":24828,"mei":18586,"eleg127":834},{"codigo":"6681","nome":"MARILIA","n":30108,"simples":22840,"mei":16358,"eleg127":1047},{"codigo":"7157","nome":"TABOAO DA SERRA","n":30101,"simples":24065,"mei":18118,"eleg127":785},{"codigo":"6929","nome":"PRESIDENTE PRUDENTE","n":29553,"simples":21462,"mei":13864,"eleg127":1264},{"codigo":"7149","nome":"SUMARE","n":29337,"simples":23956,"mei":18419,"eleg127":596},{"codigo":"6163","nome":"ARARAQUARA","n":28502,"simples":21930,"mei":14446,"eleg127":1125},{"codigo":"2951","nome":"HORTOLANDIA","n":26615,"simples":21936,"mei":17029,"eleg127":601},{"codigo":"6563","nome":"ITAQUAQUECETUBA","n":26253,"simples":21537,"mei":18298,"eleg127":411},{"codigo":"6589","nome":"JACAREI","n":25777,"simples":19880,"mei":14708,"eleg127":816},{"codigo":"6155","nome":"ARACATUBA","n":25571,"simples":19090,"mei":12573,"eleg127":991},{"codigo":"6181","nome":"ATIBAIA","n":25083,"simples":18582,"mei":11991,"eleg127":838},{"codigo":"7047","nome":"SANTANA DE PARNAIBA","n":24541,"simples":15779,"mei":8736,"eleg127":981},{"codigo":"6401","nome":"EMBU DAS ARTES","n":23496,"simples":18880,"mei":15674,"eleg127":384},{"codigo":"6251","nome":"BRAGANCA PAULISTA","n":22644,"simples":17531,"mei":11696,"eleg127":827},{"codigo":"6979","nome":"RIO CLARO","n":20226,"simples":15240,"mei":9913,"eleg127":726},{"codigo":"6579","nome":"ITU","n":19536,"simples":14516,"mei":9706,"eleg127":631},{"codigo":"6551","nome":"ITAPEVI","n":18935,"simples":15221,"mei":12808,"eleg127":303},{"codigo":"7225","nome":"VALINHOS","n":18910,"simples":14217,"mei":8692,"eleg127":729},{"codigo":"6249","nome":"BOTUCATU","n":17200,"simples":13266,"mei":9050,"eleg127":692},{"codigo":"7017","nome":"SANTA BARBARA D'OESTE","n":16799,"simples":13473,"mei":9764,"eleg127":448},{"codigo":"6311","nome":"CARAGUATATUBA","n":16286,"simples":12115,"mei":8893,"eleg127":444},{"codigo":"6831","nome":"PAULINIA","n":15170,"simples":11424,"mei":7063,"eleg127":595},{"codigo":"6715","nome":"MOGI GUACU","n":15041,"simples":11699,"mei":8192,"eleg127":453},{"codigo":"7135","nome":"SERTAOZINHO","n":14648,"simples":10942,"mei":6939,"eleg127":611},{"codigo":"6861","nome":"PINDAMONHANGABA","n":14639,"simples":11354,"mei":8240,"eleg127":535},{"codigo":"6547","nome":"ITAPETININGA","n":14149,"simples":11067,"mei":7858,"eleg127":452},{"codigo":"7005","nome":"SALTO","n":13908,"simples":11080,"mei":7735,"eleg127":418},{"codigo":"6545","nome":"ITAPECERICA DA SERRA","n":13747,"simples":10987,"mei":9080,"eleg127":204},{"codigo":"6209","nome":"BARRETOS","n":13741,"simples":9852,"mei":6704,"eleg127":541},{"codigo":"6165","nome":"ARARAS","n":13380,"simples":10381,"mei":7133,"eleg127":499},{"codigo":"7209","nome":"UBATUBA","n":13364,"simples":9964,"mei":7125,"eleg127":277},{"codigo":"6415","nome":"FERRAZ DE VASCONCELOS","n":13343,"simples":11037,"mei":9454,"eleg127":222},{"codigo":"6323","nome":"CATANDUVA","n":13191,"simples":9824,"mei":6057,"eleg127":513},{"codigo":"6569","nome":"ITATIBA","n":13146,"simples":10061,"mei":6633,"eleg127":479},{"codigo":"7243","nome":"VOTORANTIM","n":13092,"simples":10304,"mei":7868,"eleg127":321},{"codigo":"6607","nome":"JAU","n":12641,"simples":9489,"mei":6312,"eleg127":403},{"codigo":"7237","nome":"VINHEDO","n":12360,"simples":8737,"mei":5102,"eleg127":470},{"codigo":"6179","nome":"ASSIS","n":12242,"simples":9002,"mei":5780,"eleg127":512},{"codigo":"6897","nome":"POA","n":11866,"simples":8971,"mei":6812,"eleg127":343},{"codigo":"7181","nome":"TATUI","n":11729,"simples":9229,"mei":6687,"eleg127":318},{"codigo":"6229","nome":"BIRIGUI","n":11378,"simples":8880,"mei":6145,"eleg127":321},{"codigo":"6543","nome":"ITANHAEM","n":11244,"simples":8956,"mei":7203,"eleg127":212},{"codigo":"6427","nome":"FRANCISCO MORATO","n":11190,"simples":9411,"mei":8204,"eleg127":145},{"codigo":"6469","nome":"GUARATINGUETA","n":11142,"simples":8656,"mei":6019,"eleg127":385},{"codigo":"6285","nome":"CAJAMAR","n":10981,"simples":8230,"mei":5753,"eleg127":308},{"codigo":"6601","nome":"JANDIRA","n":10978,"simples":8712,"mei":6779,"eleg127":255},{"codigo":"6795","nome":"OURINHOS","n":10976,"simples":8508,"mei":5392,"eleg127":387},{"codigo":"6429","nome":"FRANCO DA ROCHA","n":10664,"simples":8663,"mei":7208,"eleg127":184},{"codigo":"6967","nome":"RIBEIRAO PIRES","n":10653,"simples":8346,"mei":6140,"eleg127":313},{"codigo":"6371","nome":"CUBATAO","n":10592,"simples":8002,"mei":6676,"eleg127":208},{"codigo":"6177","nome":"ARUJA","n":10348,"simples":7752,"mei":5445,"eleg127":307},{"codigo":"7083","nome":"SAO JOAO DA BOA VISTA","n":10340,"simples":7764,"mei":5071,"eleg127":379},{"codigo":"7233","nome":"VARZEA PAULISTA","n":10200,"simples":8529,"mei":7007,"eleg127":175},{"codigo":"7245","nome":"VOTUPORANGA","n":10138,"simples":7892,"mei":5125,"eleg127":364},{"codigo":"6717","nome":"MOGI MIRIM","n":10009,"simples":7250,"mei":4566,"eleg127":428},{"codigo":"7113","nome":"SAO ROQUE","n":9897,"simples":7336,"mei":4629,"eleg127":338},{"codigo":"7115","nome":"SAO SEBASTIAO","n":9889,"simples":6961,"mei":4601,"eleg127":258},{"codigo":"6281","nome":"CAIEIRAS","n":9732,"simples":7684,"mei":5818,"eleg127":280},{"codigo":"6635","nome":"LEME","n":9691,"simples":7501,"mei":5376,"eleg127":296},{"codigo":"6671","nome":"MAIRIPORA","n":9009,"simples":6928,"mei":4908,"eleg127":204},{"codigo":"6189","nome":"AVARE","n":8985,"simples":6788,"mei":4686,"eleg127":329},{"codigo":"6581","nome":"ITUPEVA","n":8465,"simples":6237,"mei":4187,"eleg127":228},{"codigo":"2965","nome":"BERTIOGA","n":8346,"simples":5883,"mei":4045,"eleg127":205},{"codigo":"6271","nome":"CACAPAVA","n":8242,"simples":6519,"mei":4792,"eleg127":262},{"codigo":"6853","nome":"PERUIBE","n":8066,"simples":6331,"mei":4702,"eleg127":206},{"codigo":"6595","nome":"JAGUARIUNA","n":8024,"simples":5659,"mei":3715,"eleg127":276},{"codigo":"6221","nome":"BEBEDOURO","n":7897,"simples":5920,"mei":3678,"eleg127":315},{"codigo":"6239","nome":"BOITUVA","n":7888,"simples":5893,"mei":3832,"eleg127":250},{"codigo":"6549","nome":"ITAPEVA","n":7833,"simples":5789,"mei":3887,"eleg127":293},{"codigo":"6687","nome":"MATAO","n":7776,"simples":5735,"mei":3782,"eleg127":272}]};
const fmt = n => n.toLocaleString('pt-BR');
const pct = (a,b) => b ? (a/b*100) : 0;
const pf = (x,d=0) => x.toLocaleString('pt-BR',{maximumFractionDigits:d,minimumFractionDigits:d})+'%';
const brl = n => n.toLocaleString('pt-BR',{style:'currency',currency:'BRL',maximumFractionDigits:0});
const title = s => s.toLowerCase().replace(/(^|\\s|-|\\()(\\p{L})/gu,(m,a,b)=>a+b.toUpperCase()).replace(/\\b(De|Da|Do|Das|Dos|E|Em)\\b/g,w=>w.toLowerCase());

const div = c => +c.codigo.slice(0,2);
function reducao(c){
  if (c.eleg127>0) return {r:30, why:'profissão regulamentada (art. 127)'};
  const d = div(c);
  if ([86,87,58,59,60,90,91,92].includes(d)) return {r:60, why: d>=86&&d<=87?'saúde (art. 128)':'cultura ou comunicação (art. 128)'};
  if (d===85 && +c.codigo.slice(0,3)<=855) return {r:60, why:'educação — só se for ensino regular (art. 128)', check:true};
  return {r:0};
}

const cnaes = D.top_cnaes.map((c,i)=>({...c, rank:i+1, nome:c.descricao.replace(/\\.$/,''), red:reducao(c)}));
const cities = D.top_municipios;

document.getElementById('comp').textContent = 'Dados da Receita Federal, competência ' + D.competencia.split('-').reverse().join('/');
document.getElementById('foot').textContent = \`Fonte: Radar da Reforma (indice.ia.br), base \${D.build_id}. \${fmt(D.total)} estabelecimentos ativos de serviços em SP (CNAE 49–96, exceto 84).\`;

// city select
const sel = document.getElementById('city');
sel.innerHTML = '<option value="">Todo o estado de SP</option>' + cities.map(c=>\`<option value="\${c.codigo}">\${title(c.nome)}</option>\`).join('');

// combobox
const q = document.getElementById('q'), lst = document.getElementById('lst');
let cur = cnaes.find(c=>c.codigo==='6911701') || cnaes[0], hi = -1, shown=[];
const norm = s => s.normalize('NFD').replace(/[\\u0300-\\u036f]/g,'').toLowerCase();
function renderList(){
  const t = norm(q.value.trim());
  shown = cnaes.filter(c=>!t || norm(c.nome).includes(t) || c.codigo.startsWith(t)).slice(0,40);
  lst.innerHTML = shown.length ? shown.map((c,i)=>\`<div class="opt" role="option" id="o\${i}" aria-selected="\${i===hi}" data-i="\${i}"><span>\${c.nome}</span><small>\${fmt(c.n)}</small></div>\`).join('')
    : '<div class="opt"><span>Nenhum ramo encontrado. Tente outra palavra.</span></div>';
  lst.classList.add('open'); q.setAttribute('aria-expanded','true');
}
function close(){lst.classList.remove('open');q.setAttribute('aria-expanded','false');hi=-1}
function pick(c){cur=c;q.value=c.nome;close();renderVerdict();syncSim(true)}
q.addEventListener('focus',()=>{q.select();renderList()});
q.addEventListener('input',()=>{hi=-1;renderList()});
q.addEventListener('keydown',e=>{
  if(e.key==='ArrowDown'){hi=Math.min(hi+1,shown.length-1);renderList();e.preventDefault()}
  else if(e.key==='ArrowUp'){hi=Math.max(hi-1,0);renderList();e.preventDefault()}
  else if(e.key==='Enter'&&shown[hi>=0?hi:0]){pick(shown[hi>=0?hi:0]);e.preventDefault()}
  else if(e.key==='Escape'){q.value=cur.nome;close()}
});
lst.addEventListener('mousedown',e=>{const o=e.target.closest('[data-i]');if(o){e.preventDefault();pick(shown[+o.dataset.i])}});
q.addEventListener('blur',()=>setTimeout(()=>{if(lst.classList.contains('open')){q.value=cur.nome;close()}},120));
sel.addEventListener('change',renderVerdict);

function renderVerdict(){
  const c = cur, red = c.red, city = cities.find(x=>x.codigo===sel.value);
  const sPct = pct(c.simples,c.n), mPct = pct(c.mei,c.n);
  let lead;
  if (red.r===30) lead = \`Boa notícia: o seu ramo tem <b>redução de 30%</b> no novo imposto.\`;
  else if (red.r===60 && !red.check) lead = \`Boa notícia: o seu ramo tem <b>redução de 60%</b> no novo imposto.\`;
  else if (red.check) lead = \`Seu ramo <b>pode ter redução de 60%</b> — depende de ser ensino regular.\`;
  else lead = \`Seu ramo <b>não tem redução</b> específica: paga a alíquota cheia do novo imposto.\`;
  document.getElementById('lead').innerHTML = lead;
  let peer = \`\${title(c.nome)} é o \${c.rank}º ramo de serviços com mais empresas em SP: \${fmt(c.n)} estabelecimentos.\`;
  if (city) peer += \` Em \${title(city.nome)} há \${fmt(city.n)} empresas de serviços, \${pf(pct(city.simples,city.n))} delas no Simples.\`;
  document.getElementById('peer').textContent = peer;

  const A = [];
  if (red.r) A.push({k:red.check?'warn':'good',i:red.check?'?':'✓',t: red.check?'Redução depende do tipo de ensino':\`Redução de \${red.r}% confirmada pelo CNAE\`,
    d: red.r===30?'Vale para sociedades de profissionais regulamentados. Verifique se a sua empresa cumpre os requisitos societários.':red.check?'Cursos livres e treinamentos ficam fora. Ensino infantil, fundamental, médio e superior entram.':'Confirme com o contador se todos os serviços que você presta estão cobertos.'});
  else A.push({k:'neutral',i:'–',t:'Sem redução específica',d:'O preço do serviço vai carregar a alíquota cheia. Vale revisar preço e margem antes da virada.'});
  A.push(sPct>=50
    ? {k:'warn',i:'!',t:\`\${pf(sPct)} do seu ramo está no Simples\`,d:\`Se você é um deles, precisa decidir se recolhe IBS/CBS dentro ou fora do DAS. \${mPct>=30?pf(mPct)+' do ramo é MEI.':''}\`}
    : {k:'neutral',i:'i',t:\`Só \${pf(sPct)} do seu ramo está no Simples\`,d:'A maioria já está no regime normal e entra direto nas regras gerais de IBS e CBS.'});
  A.push(red.r===0
    ? {k:'risk',i:'!',t:'Confira se o seu CNAE está certo',d:\`\${fmt(D.flags.cnae_suspeito)} empresas em SP têm atividade principal sem benefício mas secundária com benefício. Se for o seu caso, a correção pode valer dinheiro.\`}
    : {k:'good',i:'✓',t:'Mantenha o CNAE principal como está',d:'O benefício depende da atividade principal. Mudar o CNAE sem cuidado pode fazer você perder a redução.'});
  document.getElementById('answers').innerHTML = A.map(a=>\`<div class="ans \${a.k}"><span class="dot" aria-hidden="true">\${a.i}</span><div><h3>\${a.t}</h3><p>\${a.d}</p></div></div>\`).join('');
}

// simulator
let simR = 0;
const segBtns = [...document.querySelectorAll('#redseg button')];
function setR(r){simR=r;segBtns.forEach(b=>b.setAttribute('aria-pressed',+b.dataset.r===r));calc()}
segBtns.forEach(b=>b.addEventListener('click',()=>setR(+b.dataset.r)));
function syncSim(){
  setR(cur.red.r);
  document.getElementById('redhint').textContent = \`Pré-selecionado pelo seu ramo: \${cur.red.r?cur.red.r+'% — '+cur.red.why:'sem redução'}.\`;
}
function calc(){
  const f = Math.max(0,+document.getElementById('fat').value||0), r = Math.max(0,+document.getElementById('rate').value||0)/100;
  const full = f*r, red = full*(1-simR/100);
  document.getElementById('v0').textContent = brl(full)+'/mês';
  document.getElementById('v1').textContent = brl(red)+'/mês';
  document.getElementById('v2').textContent = brl((full-red)*12);
  document.getElementById('b0').style.width = full?'100%':'0';
  document.getElementById('b1').style.width = full?(red/full*100)+'%':'0';
}
['fat','rate'].forEach(id=>document.getElementById(id).addEventListener('input',calc));

// panorama
const F = D.flags, T = D.total;
document.getElementById('pano-sub').textContent = \`\${fmt(T)} estabelecimentos de serviços ativos no estado. Uma mesma empresa pode aparecer em mais de um grupo.\`;
const pano = [
  {n:F.decisao_simples,c:'c-warn',t:'precisam decidir sobre o Simples',d:'Optantes do Simples escolhem como recolher o novo imposto.'},
  {n:F.elegivel_128,c:'c-good',t:'têm redução de 60%',d:'Saúde, educação regular, cultura e jornalismo.'},
  {n:F.elegivel_127,c:'c-good',t:'têm redução de 30%',d:'As 18 profissões regulamentadas: advocacia, contabilidade, engenharia…'},
  {n:F.cnae_suspeito,c:'c-risk',t:'devem revisar o CNAE',d:'Atividade principal sem benefício, mas secundária com benefício.'},
];
document.getElementById('pano').innerHTML = pano.map(p=>\`<div><div class="num \${p.c}">\${fmt(p.n)}</div><div class="pct">\${pf(pct(p.n,T),1)} \${p.t}</div><p class="d">\${p.d}</p></div>\`).join('');

// porte
const portes = [['01','Microempresa (ME)'],['03','Pequeno porte (EPP)'],['05','Médias e grandes']];
document.getElementById('porte').innerHTML = portes.map(([k,lab])=>{
  const p = D.por_porte[k]; if(!p) return '';
  const mei = pct(p.mei,p.n), simp = pct(p.simples-p.mei,p.n);
  return \`<div class="prow" style="margin-top:14px"><div><strong>\${lab}</strong><div class="muted" style="font-size:.88rem">\${fmt(p.n)} empresas</div></div>
  <div class="stack" role="img" aria-label="\${lab}: \${pf(mei)} MEI, \${pf(simp)} Simples sem MEI"><span style="width:\${mei}%;background:var(--warn)"></span><span style="width:\${simp}%;background:color-mix(in srgb,var(--warn) 45%,var(--paper))"></span></div>
  <div class="n" style="text-align:right"><strong>\${pf(pct(p.simples,p.n))}</strong><div class="muted" style="font-size:.82rem">no Simples</div></div></div>\`;
}).join('');

// tables
const benef = cnaes.filter(c=>c.red.r>0).sort((a,b)=>b.n-a.n).slice(0,12);
document.querySelector('#t-benef tbody').innerHTML = benef.map(c=>\`<tr class="clickable" tabindex="0" data-c="\${c.codigo}"><td>\${c.nome}</td><td><span class="chip \${c.red.check?'w':'g'}">\${c.red.r}%\${c.red.check?' *':''}</span></td><td class="n">\${fmt(c.n)}</td></tr>\`).join('');
document.querySelectorAll('#t-benef tr.clickable').forEach(tr=>{
  const go=()=>{pick(cnaes.find(c=>c.codigo===tr.dataset.c));document.querySelector('.picker').scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'})};
  tr.addEventListener('click',go);tr.addEventListener('keydown',e=>{if(e.key==='Enter')go()});
});
const cityRank = [...cities].sort((a,b)=>b.eleg127-a.eleg127).slice(0,12);
document.querySelector('#t-city tbody').innerHTML = cityRank.map(c=>\`<tr><td>\${title(c.nome)}</td><td class="n">\${fmt(c.eleg127)}</td><td class="n">\${pf(pct(c.eleg127,c.n),1)}</td></tr>\`).join('');

q.value = cur.nome; renderVerdict(); syncSim();
</script>

<script>
(function(){
  try{
    const c = localStorage.getItem("agg_cache");
    if (c) window.__AGG__ = JSON.parse(c);
  }catch(e){}
})();
fetch("/api/radar/analise").then(r => r.ok ? r.json() : null).then(novo => {
  if (!novo || !novo.total) return;
  try{ localStorage.setItem("agg_cache", JSON.stringify(novo)); }catch(e){}
  if (typeof D !== "undefined" && novo.build_id !== D.build_id && !sessionStorage.getItem("agg_rf")){
    sessionStorage.setItem("agg_rf", "1");
    location.reload();
  }
}).catch(() => {});
</script>
</body>
</html>
`;

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const p = url.pathname;

    if (p === "/pro" && req.method === "GET") {
      return new Response(PRO_HTML, { headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-cache, must-revalidate",
      } });
    }
    if (p === "/dash" && req.method === "GET") {
      return new Response(DASH_HTML, { headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-cache, must-revalidate",
      } });
    }
    if (p === "/app" && req.method === "GET") {
      return new Response(APP_HTML, { headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-cache, must-revalidate",
      } });
    }
    if (p === "/radar" && req.method === "GET") {
      return new Response(MONITOR_HTML, { headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-cache, must-revalidate",
      } });
    }
    if (p === "/internal/radar/load" && req.method === "POST") {
      if (!autorizado(req, env, "internal")) return json({ erro: "nao autorizado" }, 401);
      return carregar(env, req);
    }
    if (!p.startsWith("/api/radar")) return json({ erro: "rota desconhecida" }, 404);
    // API publica (demonstracao/venda); /internal segue protegido por chave.

    if (p === "/api/radar/status" && req.method === "GET") return status(env);
    if (p === "/api/radar/pipeline" && req.method === "GET") return pipelineJson(env);
    if (p === "/api/radar/painel" && req.method === "GET") return painelJson(env);
    if (p === "/api/radar/analise" && req.method === "GET") return analiseJson(env);
    if (p === "/api/radar/explorar" && req.method === "GET") return explorar(env, url);
    const mCnpj = p.match(/^\/api\/radar\/cnpj\/([0-9A-Za-z./-]+)$/);
    if (mCnpj && req.method === "GET") return consultaCnpj(env, mCnpj[1]);
    if (p === "/api/radar/carteiras" && req.method === "POST") return novaCarteira(env, req);
    let m = p.match(/^\/api\/radar\/carteiras\/([a-f0-9]{24})\/cruzar$/);
    if (m && req.method === "POST") return cruzar(env, m[1]);
    m = p.match(/^\/api\/radar\/triage\/([a-f0-9]{24})$/);
    if (m && req.method === "GET") return triage(env, m[1], url);
    m = p.match(/^\/api\/radar\/triage\/([a-f0-9]{24})\/export$/);
    if (m && req.method === "GET") return exportar(env, m[1]);
    return json({ erro: "rota desconhecida" }, 404);
  },
};
