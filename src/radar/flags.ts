import { REGRAS } from "./regras.ts";

export interface Estabelecimento {
  cnpj: string;
  cnpj_raiz: string;
  razao_social: string;
  nome_fantasia: string | null;
  matriz_filial: string;
  cnae_principal: string;
  cnaes_secundarios: string | null;
  uf: string;
  municipio_codigo: string | null;
  porte: string | null;
  simples: string | null;
  mei: string | null;
  data_inicio: string | null;
}

export interface Avaliacao {
  flags: string[];
  score: number;
  detalhes: {
    frase_trabalho: string;
    evidencias: Record<string, unknown>;
  };
}

export function avaliar(e: Estabelecimento | null, eventos: string[], competencia: string): Avaliacao {
  if (!e) {
    return {
      flags: [],
      score: 0,
      detalhes: {
        frase_trabalho: competencia === "ao-vivo"
          ? "CNPJ nao encontrado na consulta ao vivo; verificar digitacao, baixa recente ou inaptidao."
          : `CNPJ nao encontrado no recorte ativo (competencia ${competencia}); verificar situacao ou UF fora do recorte.`,
        evidencias: { encontrado: false, competencia },
      },
    };
  }

  const flags: string[] = [];
  let score = 0;
  const frases: string[] = [];
  const p = REGRAS.pesos;

  const desc127 = REGRAS.cnaesArt127[e.cnae_principal];
  if (desc127) {
    flags.push("elegivel_127");
    score += p.elegivel_127;
    frases.push(`CNAE principal ligado a profissao regulamentada (${desc127}); verificar reducao de 30% (art. 127, LC 214/2025) — lista rascunho, validar com contador.`);
  }

  if (e.simples === "S") {
    flags.push("decisao_simples");
    score += p.decisao_simples;
    frases.push("Optante do Simples com CNAE de servico: decidir recolhimento de CBS/IBS dentro ou fora do DAS ate set/2026, valendo de 01/01/2027.");
  }

  const secundarios = (e.cnaes_secundarios ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const sec127 = secundarios.filter((s) => REGRAS.cnaesArt127[s]);
  if (!desc127 && sec127.length > 0) {
    flags.push("cnae_suspeito");
    score += p.cnae_suspeito;
    frases.push(`Atividade principal declarada pode nao refletir a atividade economica: CNAE secundario ${sec127[0]} sugere profissao regulamentada; revisar enquadramento.`);
  }

  if (eventos.includes("cnae_changed")) {
    flags.push("cnae_mudou");
    score += p.cnae_mudou;
    frases.push("CNAE alterado entre competencias; revisar o novo enquadramento tributario.");
  }

  if (frases.length === 0) {
    frases.push("Nenhuma flag tributaria no recorte atual; manter monitoramento.");
  }

  return {
    flags,
    score: Math.min(score, 100),
    detalhes: {
      frase_trabalho: frases.join(" "),
      evidencias: {
        encontrado: true,
        competencia,
        cnae_principal: e.cnae_principal,
        cnaes_secundarios: e.cnaes_secundarios,
        simples: e.simples,
        mei: e.mei,
        porte: e.porte,
        matriz_filial: e.matriz_filial,
        data_inicio: e.data_inicio,
        regras_version: REGRAS.regrasVersion,
      },
    },
  };
}
