export type Intent = "search" | "partners" | "company" | "count";

export interface SearchPlan {
  intent: Intent;
  cnpj?: string;
  name?: string;
  state?: string;
  city?: string;
  cnae?: string;
  activeOnly: boolean;
  simples?: boolean;
  mei?: boolean;
  limit: number;
}

const STATES: Record<string, string> = {
  acre:"AC", alagoas:"AL", amapa:"AP", amazonas:"AM", bahia:"BA", ceara:"CE",
  "distrito federal":"DF", "espirito santo":"ES", goias:"GO", maranhao:"MA",
  "mato grosso":"MT", "mato grosso do sul":"MS", "minas gerais":"MG", para:"PA",
  paraiba:"PB", parana:"PR", pernambuco:"PE", piaui:"PI", "rio de janeiro":"RJ",
  "rio grande do norte":"RN", "rio grande do sul":"RS", rondonia:"RO", roraima:"RR",
  "santa catarina":"SC", "sao paulo":"SP", sergipe:"SE", tocantins:"TO"
};

export const normalize = (value: string) => value.normalize("NFD")
  .replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9 ]/g, " ")
  .replace(/\s+/g, " ").trim();

export function heuristicPlan(question: string): SearchPlan {
  const q = normalize(question);
  // Desde julho/2026, básico e ordem podem conter A-Z; DV continua numérico.
  const cnpjMatch = question.toUpperCase().match(/\b[A-Z0-9]{2}\.?[A-Z0-9]{3}\.?[A-Z0-9]{3}\/?[A-Z0-9]{4}-?\d{2}\b/);
  const cnpj = cnpjMatch?.[0].replace(/[^A-Z0-9]/g, "");
  const uf = q.match(/(?:\bem\b|\bno\b|\bna\b)\s+([a-z]{2})(?:\b|$)/)?.[1]?.toUpperCase();
  const state = uf && Object.values(STATES).includes(uf) ? uf :
    Object.entries(STATES).find(([name]) => q.includes(name))?.[1];
  const city = q.match(/(?:\bem\b|\bde\b)\s+([a-z ]+?)(?:,|\s+(?:no|na|com|que|do|da)\b|$)/)?.[1]
    ?.replace(/\b(?:ac|al|ap|am|ba|ce|df|es|go|ma|mt|ms|mg|pa|pb|pr|pe|pi|rj|rn|rs|ro|rr|sc|sp|se|to)$/, "").trim();
  const quoted = question.match(/["“”']([^"“”']+)["“”']/)?.[1];

  return {
    intent: /soci[oa]s?/.test(q) ? "partners" : cnpj ? "company" : /quant[oa]s?|numero|total/.test(q) ? "count" : "search",
    cnpj,
    name: quoted || undefined,
    state,
    city: city && city.length > 2 ? city.toUpperCase() : undefined,
    activeOnly: !/(baixad|inativ|suspens)/.test(q),
    simples: /simples nacional/.test(q) ? true : undefined,
    mei: /\bmeis?\b/.test(q) ? true : undefined,
    limit: 25
  };
}

export function sanitizePlan(input: Partial<SearchPlan>, fallback: SearchPlan): SearchPlan {
  const allowed: Intent[] = ["search", "partners", "company", "count"];
  const state = input.state?.toUpperCase();
  return {
    intent: allowed.includes(input.intent as Intent) ? input.intent as Intent : fallback.intent,
    cnpj: input.cnpj?.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 14) || fallback.cnpj,
    name: input.name?.slice(0, 120) || fallback.name,
    state: state && /^[A-Z]{2}$/.test(state) ? state : fallback.state,
    city: input.city?.toUpperCase().slice(0, 80) || fallback.city,
    cnae: input.cnae?.replace(/\D/g, "").slice(0, 7) || fallback.cnae,
    activeOnly: input.activeOnly ?? fallback.activeOnly,
    simples: typeof input.simples === "boolean" ? input.simples : fallback.simples,
    mei: typeof input.mei === "boolean" ? input.mei : fallback.mei,
    limit: Math.min(Math.max(Number(input.limit) || fallback.limit, 1), 100)
  };
}
