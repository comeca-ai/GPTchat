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

function divisaoCnae(cnae: string): number {
  const d = parseInt((cnae ?? "").slice(0, 2), 10);
  return Number.isNaN(d) ? -1 : d;
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
  const g = REGRAS.gruposArt128;
  const div = divisaoCnae(e.cnae_principal);
  let grupo128: string | null = null;
  if (g.saude.divisoes.includes(div)) grupo128 = g.saude.rotulo;
  else if (g.educacao.cnaes.includes(e.cnae_principal)) grupo128 = g.educacao.rotulo;
  else if (g.cultura.divisoes.includes(div)) grupo128 = g.cultura.rotulo;

  if (desc127) {
    flags.push("elegivel_127");
    score += p.elegivel_127;
    frases.push(`Profissao do rol do art. 127 (${desc127}): verificar reducao de 30% do IBS/CBS; na PJ, exige requisitos societarios (socios habilitados, sem PJ no quadro).`);
  } else if (grupo128) {
    flags.push("elegivel_128");
    score += p.elegivel_128;
    frases.push(`${grupo128}. Prevalece a maior reducao quando houver mais de uma.`);
  }

  if (e.simples === "S") {
    flags.push("decisao_simples");
    score += p.decisao_simples;
    frases.push("Optante do Simples com CNAE de servico: ate 30/10/2026, optar no Portal do Simples pelo recolhimento de CBS/IBS dentro ou fora do DAS (Resolucao CGSN 194/2026), valendo jan-jun/2027; desistencia de 03/11 a 20/12/2026.");
  }

  const secundarios = (e.cnaes_secundarios ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const sec127 = secundarios.filter((s) => REGRAS.cnaesArt127[s]);
  const sec128 = secundarios.filter((s) =>
    REGRAS.gruposArt128.saude.divisoes.includes(divisaoCnae(s))
    || REGRAS.gruposArt128.educacao.cnaes.includes(s)
    || REGRAS.gruposArt128.cultura.divisoes.includes(divisaoCnae(s)));
  if (!desc127 && !flags.includes("elegivel_128") && (sec127.length > 0 || sec128.length > 0)) {
    flags.push("cnae_suspeito");
    score += p.cnae_suspeito;
    const alvo = sec127[0] ?? sec128[0];
    frases.push(`Atividade principal pode nao refletir a atividade economica: CNAE secundario ${alvo} sugere atividade com beneficio fiscal; revisar enquadramento.`);
  }

  if (eventos.includes("cnae_changed")) {
    flags.push("cnae_mudou");
    score += p.cnae_mudou;
    frases.push("CNAE alterado entre competencias; revisar o novo enquadramento tributario.");
  }

  if (frases.length === 0) {
    const motivoSimples = e.simples === "S" ? "" : "nao consta como optante do Simples; ";
    frases.push(
      `Sem acao identificada: CNAE ${e.cnae_principal} fora do rol do art. 127 e da saude (art. 128); ${motivoSimples}manter monitoramento — novas reducoes e atos do Comite Gestor sao reavaliados a cada competencia.`
    );
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
