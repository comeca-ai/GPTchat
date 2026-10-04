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
      headers: { "user-agent": "gptchat-radar/0.1" }, signal: AbortSignal.timeout(10_000),
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
    const estab = await env.RADAR_DB.prepare(
      `SELECT * FROM radar_estabelecimentos
       WHERE build_id = ? AND (cnpj IN (${marcas(cnpjs.length)}) OR cnpj_raiz IN (${marcas(raizes.length)}))`
    ).bind(build.build_id, ...cnpjs, ...raizes).all();
    const porRaiz = new Map<string, Estabelecimento>();
    for (const row of (estab.results ?? []) as unknown as Estabelecimento[]) {
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

/* ---------- analise agregada + exploracao da base ---------- */

let aggCache: { build: string; dados: unknown; ts: number } | null = null;

async function analiseJson(env: Env): Promise<Response> {
  const build = await buildAtivo(env) as { build_id: string } | null;
  if (!build) return json({ erro: "nenhum build ativo" }, 409);
  if (aggCache && aggCache.build === build.build_id && Date.now() - aggCache.ts < 300_000) {
    return json(aggCache.dados);
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
<div class="card" id="auth" style="display:none">
  <span class="k">chave de leitura (RADAR_API_KEY)</span><br>
  <input id="chave" type="password"> <button onclick="salvar()">entrar</button>
</div>
<div class="card"><div class="k">agora</div><div class="v" id="fase">—</div></div>
<div class="card"><table>
  <thead><tr><th>arquivo</th><th>grupo</th><th>progresso</th><th>%</th><th>vel.</th><th>status</th></tr></thead>
  <tbody id="rows"></tbody>
</table></div>
<div id="status">atualizando a cada 15s…</div>
<script>
let key = localStorage.getItem("radar_key") || "";
if (!key) document.getElementById("auth").style.display = "block";
function salvar(){ key = document.getElementById("chave").value;
  localStorage.setItem("radar_key", key); document.getElementById("auth").style.display = "none"; tick(); }
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
    const r = await fetch("/api/radar/painel", {headers: {"x-radar-key": key}});
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
let KEY = localStorage.getItem("radar_key") || "";
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


const APP_HTML = `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Otimizador de CNAEs — sua carteira na reforma tributária</title>
<style>
  *{box-sizing:border-box}
  body{font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",sans-serif;
       background:#fbfbfd;color:#1d1d1f;margin:0;padding:0;-webkit-font-smoothing:antialiased}
  .wrap{max-width:720px;margin:0 auto;padding:48px 20px 80px}
  .hero{text-align:center;margin-bottom:36px}
  .hero h1{font-size:32px;font-weight:700;letter-spacing:-.02em;margin:0 0 8px}
  .hero p{color:#6e6e73;font-size:16px;margin:0}
  .card{background:#fff;border-radius:16px;padding:24px;margin:14px 0;
        box-shadow:0 1px 3px rgba(0,0,0,.06),0 4px 16px rgba(0,0,0,.05);border:1px solid #eeeef0}
  .passo{font-size:12px;font-weight:700;color:#0071e3;text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px}
  textarea{width:100%;min-height:130px;border:1px solid #d2d2d7;border-radius:12px;padding:14px;
           font-family:ui-monospace,Menlo,monospace;font-size:13px;resize:vertical;outline:none}
  textarea:focus{border-color:#0071e3;box-shadow:0 0 0 3px rgba(0,113,227,.15)}
  .btn{display:inline-block;background:#0071e3;color:#fff;border:0;border-radius:980px;
       padding:13px 28px;font-size:15px;font-weight:600;cursor:pointer}
  .btn:disabled{opacity:.4;cursor:wait}
  .btn.sec{background:#e8e8ed;color:#1d1d1f}
  input[type=text],input[type=password]{border:1px solid #d2d2d7;border-radius:10px;padding:10px 12px;font-size:14px;outline:none}
  input:focus{border-color:#0071e3}
  .resumo{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;text-align:center}
  .resumo .n{font-size:26px;font-weight:700;letter-spacing:-.02em}
  .resumo .l{font-size:12px;color:#6e6e73;margin-top:2px}
  .destaque{color:#0071e3}
  .emp{display:flex;gap:14px;align-items:flex-start;padding:16px 0;border-top:1px solid #eeeef0}
  .emp:first-child{border-top:0}
  .emp .info{flex:1}
  .emp .nome{font-weight:600;font-size:14px}
  .emp .meta{font-size:12px;color:#6e6e73;margin-top:2px}
  .pill{display:inline-block;border-radius:980px;padding:4px 12px;font-size:11px;font-weight:600;margin:2px 4px 2px 0}
  .p-verde{background:#e8f7ee;color:#0d7a3f}
  .p-amarela{background:#fff4d6;color:#8a6100}
  .p-laranja{background:#ffeadd;color:#a04a00}
  .p-cinza{background:#f5f5f7;color:#6e6e73}
  .acao{font-size:13px;color:#1d1d1f;margin-top:8px;line-height:1.45;background:#f5f5f7;border-radius:10px;padding:10px 12px}
  .acao b{color:#0071e3}
  #msg{font-size:13px;color:#6e6e73;text-align:center;margin-top:10px}
  .toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:4px}
  .toolbar input{flex:1;min-width:180px}
  @media(max-width:560px){.resumo{grid-template-columns:1fr 1fr}.hero h1{font-size:26px}}
</style></head><body>
<div class="wrap">
  <div class="hero">
    <h1>Otimizador de CNAEs</h1>
    <p>Cole a carteira de CNPJs. Descubra em segundos quem pode pagar menos imposto<br>
    na reforma tributária — e o que fazer em cada empresa.</p>
  </div>

  <div class="card" id="auth" style="display:none;text-align:center">
    <div class="passo">Acesso</div>
    <input type="password" id="chave" placeholder="sua chave" style="width:260px">
    <button class="btn" onclick="entrar()">Entrar</button>
  </div>

  <div id="app" style="display:none">
    <div class="card">
      <div class="passo">Passo 1 · A carteira</div>
      <textarea id="cnpjs" placeholder="Cole aqui os CNPJs, um por linha (com ou sem pontuação)&#10;ou escolha o arquivo CSV abaixo"></textarea>
      <div style="display:flex;gap:10px;align-items:center;margin-top:12px;flex-wrap:wrap">
        <input type="file" id="arquivo" accept=".csv,.txt" style="font-size:13px">
        <button class="btn" id="btn-go" onclick="analisar()">Analisar carteira</button>
      </div>
      <div id="msg"></div>
    </div>

    <div id="resultado" style="display:none">
      <div class="card">
        <div class="passo">Passo 2 · O resultado</div>
        <div class="resumo">
          <div><div class="n" id="r-total">—</div><div class="l">empresas analisadas</div></div>
          <div><div class="n destaque" id="r-oport">—</div><div class="l">com oportunidade</div></div>
          <div><div class="n" id="r-sem">—</div><div class="l">sem ação necessária</div></div>
        </div>
        <div style="text-align:center;margin-top:14px">
          <button class="btn sec" onclick="baixarCsv()">⬇ Baixar planilha para o contador</button>
        </div>
      </div>
      <div class="card">
        <div class="toolbar">
          <input type="text" id="busca" placeholder="Buscar empresa ou CNPJ…" oninput="render()">
          <select id="f-acao" onchange="render()" style="border:1px solid #d2d2d7;border-radius:10px;padding:10px;font-size:13px">
            <option value="">Todas</option>
            <option value="elegivel_127">Podem pagar 30% menos</option>
            <option value="decisao_simples">Decisão do Simples</option>
            <option value="cnae_suspeito">CNAE para revisar</option>
            <option value="__sem">Sem ação</option>
          </select>
        </div>
        <div id="lista"></div>
      </div>
    </div>
  </div>
</div>
<script>
let KEY = localStorage.getItem("radar_key") || "";
let CARTEIRA = "";
let ITENS = [];
const $ = id => document.getElementById(id);
const fmt = n => n == null ? "—" : Number(n).toLocaleString("pt-BR");

const ACAO = {
  elegivel_127: {pill: ["p-verde", "Pode pagar 30% menos"], titulo: "Redução de alíquota (art. 127)",
    como: "Esta empresa tem CNAE de profissão regulamentada. Revise o enquadramento: se confirmado, ela entra na faixa de redução de 30% do IBS/CBS."},
  decisao_simples: {pill: ["p-amarela", "Decisão até set/2026"], titulo: "Simples: dentro ou fora",
    como: "Empresa do Simples. Até setembro de 2026 decida se recolhe CBS/IBS dentro ou fora do DAS — a escolha errada encarece ela para clientes PJ e ela perde contrato."},
  cnae_suspeito: {pill: ["p-laranja", "CNAE para revisar"], titulo: "CNAE principal suspeito",
    como: "A atividade principal declarada não parece refletir a atividade real (há CNAE secundário de profissão regulamentada). Corrigir o CNAE pode reduzir imposto e evitar risco fiscal."},
  cnae_mudou: {pill: ["p-cinza", "CNAE mudou"], titulo: "Mudança recente de CNAE",
    como: "O CNAE mudou entre competências. Revise o enquadramento tributário do novo código."}
};

async function api(path, opts){
  opts = opts || {};
  opts.headers = Object.assign({"x-radar-key": KEY}, opts.headers || {});
  return fetch(path, opts);
}
function entrar(){ KEY = $("chave").value.trim(); localStorage.setItem("radar_key", KEY); iniciar(); }
async function iniciar(){
  const r = await api("/api/radar/status");
  if (r.status === 401){ $("auth").style.display = "block"; return; }
  $("auth").style.display = "none";
  $("app").style.display = "block";
}
async function analisar(){
  const txt = $("cnpjs").value.trim();
  if (!txt){ msg("Cole os CNPJs primeiro 🙂"); return; }
  $("btn-go").disabled = true;
  try{
    msg("Organizando a carteira…");
    let r = await api("/api/radar/carteiras", {method: "POST", headers: {"content-type": "text/csv"}, body: txt});
    let d = await r.json();
    if (!r.ok){ msg(d.erro || "Não consegui ler os CNPJs"); return; }
    CARTEIRA = d.carteira_id;
    msg(d.total + " CNPJs válidos. Cruzando com a reforma tributária…");
    r = await api("/api/radar/carteiras/" + CARTEIRA + "/cruzar", {method: "POST"});
    d = await r.json();
    if (!r.ok){ msg(d.erro || "Erro no cruzamento"); return; }
    msg("");
    await carregar();
    $("resultado").style.display = "block";
    window.scrollTo({top: $("resultado").offsetTop - 20, behavior: "smooth"});
  }catch(e){ msg("Falha: " + e.message); }
  finally{ $("btn-go").disabled = false; }
}
async function carregar(){
  ITENS = [];
  let offset = 0;
  for(;;){
    const r = await api("/api/radar/triage/" + CARTEIRA + "?offset=" + offset);
    const d = await r.json();
    if (!r.ok){ msg(d.erro || "erro"); return; }
    ITENS = ITENS.concat(d.itens || []);
    if (d.proximo_offset == null) break;
    offset = d.proximo_offset;
  }
  render();
}
function tem(it, f){ return (it.flags || []).indexOf(f) >= 0; }
function render(){
  const q = $("busca").value.toLowerCase();
  const f = $("f-acao").value;
  const comAcao = it => it.encontrado && (it.flags || []).length > 0;
  const vis = ITENS.filter(it => {
    if (f === "__sem" && comAcao(it)) return false;
    if (f && f !== "__sem" && !tem(it, f)) return false;
    const ev = it.evidencias || {};
    return !q || ((ev.razao_social || "") + " " + it.cnpj).toLowerCase().indexOf(q) >= 0;
  });
  $("r-total").textContent = fmt(ITENS.length);
  $("r-oport").textContent = fmt(ITENS.filter(comAcao).length);
  $("r-sem").textContent = fmt(ITENS.filter(it => !comAcao(it)).length);
  $("lista").innerHTML = vis.map(it => {
    const ev = it.evidencias || {};
    const flags = it.encontrado ? (it.flags || []) : [];
    const pills = it.encontrado
      ? (flags.length ? flags.map(f => '<span class="pill ' + ACAO[f][0] + '">' + ACAO[f][1] + "</span>").join("")
                       : '<span class="pill p-cinza">Sem ação necessária</span>')
      : '<span class="pill p-cinza">Não encontrada na base</span>';
    const acoes = flags.map(f => '<div class="acao"><b>' + ACAO[f].titulo + ".</b> " + ACAO[f].como + "</div>").join("");
    return '<div class="emp"><div class="info">'
      + '<div class="nome">' + (ev.razao_social || it.cnpj) + "</div>"
      + '<div class="meta">' + it.cnpj + " · CNAE " + (ev.cnae_principal || "—")
      + (ev.municipio_codigo ? " · município " + ev.municipio_codigo : "")
      + (ev.simples === "S" ? " · Simples" : "") + "</div>"
      + '<div style="margin-top:6px">' + pills + "</div>" + acoes
      + "</div></div>";
  }).join("") || '<div class="meta" style="padding:16px">Nenhuma empresa nesse filtro.</div>';
}
async function baixarCsv(){
  const r = await api("/api/radar/triage/" + CARTEIRA + "/export");
  const blob = await r.blob();
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "otimizacao-cnaes.csv";
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
if (KEY) iniciar(); else $("auth").style.display = "block";
</script></body></html>`;


export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const p = url.pathname;

    if (p === "/pro" && req.method === "GET") {
      return new Response(PRO_HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    if (p === "/app" && req.method === "GET") {
      return new Response(APP_HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    if (p === "/radar" && req.method === "GET") {
      return new Response(MONITOR_HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    if (p === "/internal/radar/load" && req.method === "POST") {
      if (!autorizado(req, env, "internal")) return json({ erro: "nao autorizado" }, 401);
      return carregar(env, req);
    }
    if (!p.startsWith("/api/radar")) return json({ erro: "rota desconhecida" }, 404);
    if (!autorizado(req, env, "api")) return json({ erro: "nao autorizado" }, 401);

    if (p === "/api/radar/status" && req.method === "GET") return status(env);
    if (p === "/api/radar/pipeline" && req.method === "GET") return pipelineJson(env);
    if (p === "/api/radar/painel" && req.method === "GET") return painelJson(env);
    if (p === "/api/radar/analise" && req.method === "GET") return analiseJson(env);
    if (p === "/api/radar/explorar" && req.method === "GET") return explorar(env, url);
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
