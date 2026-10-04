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

/* ---------- monitoramento do pipeline ---------- */

async function pipelineJson(env: Env): Promise<Response> {
  const obj = await env.SNAPSHOTS.get("radar/status/atual.json");
  if (!obj) return json({ status: "nenhuma execucao registrada ainda" });
  return new Response(obj.body, { headers: JSONH });
}

const MONITOR_HTML = `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Radar — monitor do pipeline</title>
<style>
  body{font-family:ui-monospace,Menlo,monospace;background:#0b0f14;color:#d7e0ea;max-width:640px;margin:40px auto;padding:0 16px}
  h1{font-size:18px;color:#7ee0a3} .card{background:#131a22;border:1px solid #243242;border-radius:10px;padding:16px;margin:12px 0}
  .k{color:#7a8ca0;font-size:12px} .v{font-size:20px;margin-top:2px}
  .barra{height:10px;background:#1d2836;border-radius:5px;overflow:hidden;margin-top:8px}
  .barra>div{height:100%;background:#7ee0a3;transition:width .5s}
  #status{font-size:12px;color:#7a8ca0;margin-top:16px}
  input{background:#0b0f14;border:1px solid #243242;color:#d7e0ea;padding:6px 8px;border-radius:6px;width:220px}
  button{background:#1d2836;color:#d7e0ea;border:1px solid #243242;border-radius:6px;padding:6px 10px;cursor:pointer}
</style></head><body>
<h1>RADAR · monitor do pipeline</h1>
<div class="card" id="auth" style="display:none">
  <div class="k">chave de leitura (RADAR_API_KEY)</div>
  <input id="chave" type="password"> <button onclick="salvar()">entrar</button>
</div>
<div class="card"><div class="k">fase</div><div class="v" id="fase">—</div>
  <div class="barra"><div id="bar" style="width:0%"></div></div></div>
<div class="card"><div class="k">build</div><div class="v" id="build">—</div></div>
<div class="card"><div class="k">arquivo / progresso</div><div class="v" id="arq">—</div></div>
<div class="card"><div class="k">linhas lidas · no recorte</div><div class="v" id="linhas">—</div></div>
<div class="card"><div class="k">velocidade</div><div class="v" id="vel">—</div></div>
<div id="status">atualizando a cada 10s…</div>
<script>
let key = localStorage.getItem("radar_key") || "";
if (!key) document.getElementById("auth").style.display = "block";
function salvar(){ key = document.getElementById("chave").value;
  localStorage.setItem("radar_key", key); document.getElementById("auth").style.display = "none"; tick(); }
const fmt = n => n == null ? "—" : Number(n).toLocaleString("pt-BR");
async function tick(){
  try{
    const r = await fetch("/api/radar/pipeline", {headers: {"x-radar-key": key}});
    const d = await r.json();
    document.getElementById("fase").textContent = d.fase || d.status || "—";
    document.getElementById("build").textContent = d.build_id || "—";
    const mb = d.mb_baixados, tot = d.mb_total;
    document.getElementById("arq").textContent = d.arquivo
      ? d.arquivo + (mb != null ? " — " + fmt(mb) + (tot ? "/" + fmt(tot) : "") + " MB" : "") : "—";
    document.getElementById("bar").style.width = (mb != null && tot) ? Math.min(100, mb/tot*100) + "%" : "0%";
    document.getElementById("linhas").textContent =
      d.linhas_lidas != null ? fmt(d.linhas_lidas) + " · " + fmt(d.no_recorte) : "—";
    document.getElementById("vel").textContent = d.mbps != null ? d.mbps + " MB/s" : "—";
    document.getElementById("status").textContent = "atualizado: " + (d.atualizado_em || "—");
  }catch(e){ document.getElementById("status").textContent = "falha: " + e.message; }
}
tick(); setInterval(tick, 10000);
</script></body></html>`;

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const p = url.pathname;

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
