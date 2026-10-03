import { heuristicPlan, sanitizePlan, type SearchPlan } from "./parser.ts";
import { renderApp } from "./ui.ts";

interface Env {
  DB: D1Database;
  SNAPSHOTS: R2Bucket;
  CACHE: KVNamespace;
  AI: Ai;
  APP_NAME: string;
  LLM_MODEL: string;
  EMBEDDING_MODEL: string;
  DATA_MODE?: string;
  CF_ACCOUNT_ID?: string;
  R2_BUCKET_NAME?: string;
  BASIN_SQL_TOKEN?: string;
  DATA_NAMESPACE?: string;
  BRASIL_API_BASE?: string;
}

interface ActiveSnapshot {
  status: "ready";
  snapshot: string;
  namespace: string;
  published_at: string;
  source: string;
  files: number;
  tables: string[];
  row_counts: Record<string, number>;
}

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

async function cacheKey(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text.toLowerCase().trim()));
  return `chat:${[...new Uint8Array(digest)].map(x => x.toString(16).padStart(2, "0")).join("")}`;
}

async function planQuestion(question: string, env: Env): Promise<SearchPlan> {
  const fallback = heuristicPlan(question);
  try {
    const result = await env.AI.run(env.LLM_MODEL as Parameters<Ai["run"]>[0], {
      messages: [
        { role: "system", content: "Converta a consulta brasileira de CNPJ em JSON. Campos: intent(search|partners|company|count), cnpj, name, state(UF), city, cnae(7 dígitos), activeOnly, simples, mei, limit. Use null quando ausente. Responda somente JSON." },
        { role: "user", content: question }
      ],
      max_tokens: 250,
      temperature: 0
    } as never) as { response?: string };
    const raw = result.response?.replace(/^```json\s*|\s*```$/g, "") || "{}";
    return sanitizePlan(JSON.parse(raw), fallback);
  } catch { return fallback; }
}

async function loadActiveSnapshot(env: Env): Promise<ActiveSnapshot | null> {
  if (env.DATA_MODE !== "basin" && env.DATA_MODE !== "hybrid") return null;
  const cached = await env.CACHE.get<ActiveSnapshot>("snapshot:active", "json");
  if (cached?.status === "ready") return cached;
  const object = await env.SNAPSHOTS.get("catalog/active.json");
  if (!object) return null;
  const snapshot = await object.json<ActiveSnapshot>();
  if (snapshot.status !== "ready" || !/^[a-zA-Z0-9_]+$/.test(snapshot.namespace)) return null;
  await env.CACHE.put("snapshot:active", JSON.stringify(snapshot), { expirationTtl: 300 });
  return snapshot;
}

async function execute(plan: SearchPlan, env: Env, namespace?: string) {
  if (namespace) return executeBasin(plan, env, namespace);
  if (plan.intent === "partners") {
    const term = plan.cnpj?.slice(0, 8) || plan.name || "";
    const rs = await env.DB.prepare(`SELECT c.legal_name AS empresa, p.partner_name AS socio, p.qualification AS qualificacao, p.joined_at AS entrada FROM partners p JOIN companies c ON c.cnpj_base=p.cnpj_base WHERE (c.cnpj_base=? OR c.normalized_name LIKE ?) ORDER BY p.partner_name LIMIT ?`)
      .bind(term, `%${term.toLowerCase()}%`, plan.limit).all();
    return rs.results;
  }

  const where: string[] = ["1=1"];
  const args: unknown[] = [];
  if (plan.cnpj) { where.push("e.cnpj=?"); args.push(plan.cnpj); }
  if (plan.name) { where.push("(c.normalized_name LIKE ? OR e.normalized_trade_name LIKE ?)"); const n=`%${plan.name.toLowerCase()}%`; args.push(n,n); }
  if (plan.state) { where.push("e.state=?"); args.push(plan.state); }
  if (plan.city) { where.push("e.city LIKE ?"); args.push(`%${plan.city}%`); }
  if (plan.cnae) { where.push("e.main_cnae=?"); args.push(plan.cnae); }
  if (plan.activeOnly) where.push("e.registration_status=2");
  if (typeof plan.simples === "boolean") { where.push("COALESCE(s.simples,0)=?"); args.push(plan.simples ? 1 : 0); }
  if (typeof plan.mei === "boolean") { where.push("COALESCE(s.mei,0)=?"); args.push(plan.mei ? 1 : 0); }
  const joins = `FROM establishments e JOIN companies c ON c.cnpj_base=e.cnpj_base LEFT JOIN simples s ON s.cnpj_base=c.cnpj_base`;
  if (plan.intent === "count") {
    const row = await env.DB.prepare(`SELECT COUNT(*) AS total ${joins} WHERE ${where.join(" AND ")}`).bind(...args).first();
    return [row];
  }
  args.push(plan.limit);
  const rs = await env.DB.prepare(`SELECT e.cnpj, c.legal_name AS razao_social, e.trade_name AS nome_fantasia, e.city AS municipio, e.state AS uf, e.main_cnae AS cnae, CASE e.registration_status WHEN 2 THEN 'ATIVA' ELSE 'OUTRA' END AS situacao, COALESCE(s.simples,0) AS simples, COALESCE(s.mei,0) AS mei ${joins} WHERE ${where.join(" AND ")} ORDER BY c.legal_name LIMIT ?`).bind(...args).all();
  return rs.results;
}

const sqlString = (value: string) => `'${value.replaceAll("'", "''")}'`;
const cnpjPredicate = (alias: string, cnpj: string) =>
  `${alias}.cnpj_basico=${sqlString(cnpj.slice(0, 8))} AND ${alias}.cnpj_ordem=${sqlString(cnpj.slice(8, 12))} AND ${alias}.cnpj_dv=${sqlString(cnpj.slice(12, 14))}`;

async function executeBasin(plan: SearchPlan, env: Env, namespace?: string): Promise<Record<string, unknown>[]> {
  if (!env.CF_ACCOUNT_ID || !env.R2_BUCKET_NAME || !env.BASIN_SQL_TOKEN) throw new Error("Basin SQL não configurado");
  const ns = (namespace || env.DATA_NAMESPACE || "cnpj").replace(/[^a-zA-Z0-9_]/g, "");
  const where = ["1=1"];
  if (plan.cnpj) where.push(`(${cnpjPredicate("e", plan.cnpj)})`);
  if (plan.name) { const n=sqlString(`%${plan.name.toUpperCase()}%`); where.push(`(upper(c.razao_social) LIKE ${n} OR upper(e.nome_fantasia) LIKE ${n})`); }
  if (plan.state) where.push(`e.uf=${sqlString(plan.state)}`);
  if (plan.city) where.push(`upper(m.descricao) LIKE ${sqlString(`%${plan.city}%`)}`);
  if (plan.cnae) where.push(`e.cnae_principal=${sqlString(plan.cnae)}`);
  if (plan.activeOnly) where.push("e.situacao_cadastral='02'");
  if (typeof plan.simples === "boolean") where.push(`s.opcao_simples=${sqlString(plan.simples ? "S" : "N")}`);
  if (typeof plan.mei === "boolean") where.push(`s.opcao_mei=${sqlString(plan.mei ? "S" : "N")}`);
  let query: string;
  if (plan.intent === "partners") {
    const partnerFilter = plan.cnpj ? cnpjPredicate("e", plan.cnpj) : plan.name ? `upper(c.razao_social) LIKE ${sqlString(`%${plan.name.toUpperCase()}%`)}` : "1=0";
    query = `SELECT c.razao_social empresa,p.nome_socio socio,p.qualificacao,p.data_entrada FROM ${ns}.socios p JOIN ${ns}.empresas c ON c.cnpj_basico=p.cnpj_basico LEFT JOIN ${ns}.estabelecimentos e ON e.cnpj_basico=c.cnpj_basico AND e.matriz_filial='1' WHERE ${partnerFilter} LIMIT ${plan.limit}`;
  } else {
    const joins = `FROM ${ns}.estabelecimentos e JOIN ${ns}.empresas c ON c.cnpj_basico=e.cnpj_basico LEFT JOIN ${ns}.simples s ON s.cnpj_basico=c.cnpj_basico LEFT JOIN ${ns}.municipios m ON m.codigo=e.municipio LEFT JOIN ${ns}.naturezas n ON n.codigo=c.natureza_juridica`;
    query = plan.intent === "count" ? `SELECT count(*) total ${joins} WHERE ${where.join(" AND ")}` : `SELECT concat(e.cnpj_basico,e.cnpj_ordem,e.cnpj_dv) cnpj,c.razao_social,e.nome_fantasia,m.descricao municipio,e.uf,e.cnae_principal cnae,e.situacao_cadastral,n.descricao natureza_juridica,c.porte,s.opcao_simples simples,s.opcao_mei mei ${joins} WHERE ${where.join(" AND ")} LIMIT ${plan.limit}`;
  }
  const response = await fetch(`https://api.sql.cloudflarestorage.com/api/v1/accounts/${encodeURIComponent(env.CF_ACCOUNT_ID)}/basin-sql/query/${encodeURIComponent(env.R2_BUCKET_NAME)}`, {
    method: "POST", headers: { authorization: `Bearer ${env.BASIN_SQL_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ query })
  });
  const payload = await response.json() as { result?: { rows?: Record<string, unknown>[]; data?: Record<string, unknown>[] }; rows?: Record<string, unknown>[]; data?: Record<string, unknown>[]; errors?: unknown };
  if (!response.ok) throw new Error(`Basin SQL falhou: ${JSON.stringify(payload.errors || response.status)}`);
  return payload.result?.rows || payload.result?.data || payload.rows || payload.data || [];
}

async function respondToPlan(plan: SearchPlan, env: Env, cacheSeed: string) {
  const started = Date.now();
  const active = await loadActiveSnapshot(env);
  if ((env.DATA_MODE === "basin" || env.DATA_MODE === "hybrid") && !active) return json({ error: "A base própria ainda está sendo preparada." }, 503);
  const key = await cacheKey(`${active?.namespace || "d1"}:${cacheSeed}`);
  const cached = await env.CACHE.get(key, "json");
  if (cached) return json(cached);
  const rows = await execute(plan, env, active?.namespace);
  const localSnapshot = active ? null : await env.DB.prepare("SELECT id,published_at FROM snapshots WHERE status='ready' ORDER BY published_at DESC LIMIT 1").first<{id:string;published_at:string}>();
  const answer = plan.intent === "count" ? `Encontrei ${Number((rows[0] as {total?:number})?.total || 0).toLocaleString("pt-BR")} registros.` :
    rows.length ? `Encontrei ${rows.length} resultado${rows.length === 1 ? "" : "s"}.` : "Não encontrei resultados com esses filtros.";
  const payload = { answer, rows, plan, meta: { snapshot: active ? `${active.snapshot} (${active.published_at})` : localSnapshot ? `${localSnapshot.id} (${localSnapshot.published_at})` : null, source: active?.source || null, elapsedMs: Date.now()-started } };
  await env.CACHE.put(key, JSON.stringify(payload), { expirationTtl: 900 });
  return json(payload);
}

async function handleChat(request: Request, env: Env) {
  const body = await request.json<{ question?: string }>();
  const question = body.question?.trim();
  if (!question || question.length > 500) return json({ error: "Envie uma pergunta de até 500 caracteres." }, 400);
  return respondToPlan(await planQuestion(question, env), env, question);
}

interface BrasilApiCompany {
  cnpj?: string;
  razao_social?: string;
  nome_fantasia?: string;
  municipio?: string;
  uf?: string;
  cnae_fiscal?: number | string;
  cnae_fiscal_descricao?: string;
  descricao_situacao_cadastral?: string;
  descricao_natureza_juridica?: string;
  codigo_natureza_juridica?: number | string;
  descricao_porte?: string;
  opcao_pelo_simples?: boolean | null;
  opcao_pelo_mei?: boolean | null;
  data_inicio_atividade?: string;
  capital_social?: number;
}

export function normalizeBrasilApi(company: BrasilApiCompany) {
  return {
    cnpj: String(company.cnpj || "").replace(/\D/g, ""),
    razao_social: company.razao_social || null,
    nome_fantasia: company.nome_fantasia || null,
    municipio: company.municipio || null,
    uf: company.uf || null,
    cnae: company.cnae_fiscal == null ? null : String(company.cnae_fiscal),
    atividade_principal: company.cnae_fiscal_descricao || null,
    situacao: company.descricao_situacao_cadastral || null,
    natureza_juridica: company.descricao_natureza_juridica || (company.codigo_natureza_juridica == null ? null : String(company.codigo_natureza_juridica)),
    porte: company.descricao_porte || null,
    simples: company.opcao_pelo_simples ?? null,
    mei: company.opcao_pelo_mei ?? null,
    abertura: company.data_inicio_atividade || null,
    capital_social: company.capital_social ?? null,
  };
}

async function respondFromBrasilApi(cnpj: string, env: Env) {
  const started = Date.now();
  const key = `brasilapi:cnpj:${cnpj}`;
  const cached = await env.CACHE.get(key, "json");
  if (cached) return json(cached);
  const base = (env.BRASIL_API_BASE || "https://brasilapi.com.br/api").replace(/\/$/, "");
  const source = `${base}/cnpj/v1/${cnpj}`;
  const response = await fetch(source, {
    headers: { accept: "application/json", "user-agent": "GPTchat-CNPJ/1.0" },
    signal: AbortSignal.timeout(10_000),
  });
  const body = await response.json().catch(() => ({})) as BrasilApiCompany & { message?: string };
  if (response.status === 404) return json({ error: "CNPJ não encontrado na BrasilAPI." }, 404);
  if (!response.ok) throw new Error(body.message || `BrasilAPI indisponível (${response.status})`);
  const payload = {
    answer: "Encontrei 1 resultado.",
    rows: [normalizeBrasilApi(body)],
    plan: { intent: "company", cnpj, activeOnly: false, limit: 1 },
    meta: { snapshot: "BrasilAPI (consulta online)", source, elapsedMs: Date.now() - started },
  };
  await env.CACHE.put(key, JSON.stringify(payload), { expirationTtl: 86400 });
  return json(payload);
}

async function handleCnpj(raw: string, env: Env) {
  const cnpj = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!/^[A-Z0-9]{12}\d{2}$/.test(cnpj)) return json({ error: "Informe um CNPJ válido com 14 caracteres." }, 400);
  const plan: SearchPlan = { intent: "company", cnpj, activeOnly: false, limit: 1 };
  const active = await loadActiveSnapshot(env);
  if (active) {
    try { return await respondToPlan(plan, env, cnpj); }
    catch { /* BrasilAPI mantém a consulta disponível durante falhas do snapshot. */ }
  }
  try { return await respondFromBrasilApi(cnpj, env); }
  catch { return json({ error: "Fonte temporariamente indisponível. Tente novamente em instantes." }, 503); }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/") return new Response(renderApp(env.APP_NAME || "CNPJ Aberto"), { headers: { "content-type": "text/html;charset=UTF-8", "cache-control": "public,max-age=300" } });
    if (request.method === "GET" && url.pathname === "/api/health") {
      const snapshot = await loadActiveSnapshot(env);
      return json({ ok: Boolean(snapshot) || env.DATA_MODE === "hybrid" || env.DATA_MODE !== "basin", mode: env.DATA_MODE || "d1", fallback: snapshot ? null : "brasilapi", snapshot });
    }
    if (request.method === "GET" && url.pathname.startsWith("/api/cnpj/")) return handleCnpj(url.pathname.slice(10), env);
    if (request.method === "POST" && url.pathname === "/api/chat") return handleChat(request, env);
    return json({ error: "Rota não encontrada" }, 404);
  }
} satisfies ExportedHandler<Env>;
