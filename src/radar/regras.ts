/** MANTER EM SYNC com pipeline/radar/regras_tributarias.json.
 * v3: art. 127 (18 profissoes, 30%) + art. 128 por grupos:
 * saude (86-87), educacao (8 CNAEs do Anexo II — apoio/cursos livres fora),
 * cultura/jornalismo/audiovisual (58-60, 90-92, parcial).
 */
export const REGRAS = {
  regrasVersion: "2026-10-05.fundamentada-v3",
  cnaesArt127: {
    "6911701": "Servicos advocaticios (advogados, OAB)",
    "6911702": "Atividades auxiliares da justica (pericia judicial, mediacao/arbitragem — parcial)",
    "6920601": "Atividades de contabilidade (contabilistas, CRC)",
    "6920602": "Consultoria e auditoria contabil e tributaria (contabilistas, CRC)",
    "7111100": "Servicos de arquitetura (arquitetos e urbanistas, CAU)",
    "7112000": "Servicos de engenharia (engenheiros, CREA)",
    "7119701": "Cartografia, topografia e geodesia (engenheiros/tecnicos — parcial)",
    "7119702": "Estudos geologicos (engenheiros/tecnicos — parcial)",
    "7119703": "Desenho tecnico relacionado a arquitetura e engenharia (tecnicos — parcial)",
    "7119704": "Pericia tecnica de seguranca do trabalho (engenheiros/tecnicos — parcial)",
    "7119799": "Outras atividades tecnicas relacionadas a engenharia e arquitetura (parcial)",
    "7120100": "Ensaios e analises tecnicas (quimicos, CRQ — parcial)",
    "7210000": "Pesquisa e desenvolvimento em ciencias fisicas e naturais (biologos — parcial)",
    "7320300": "Pesquisas de mercado e de opiniao publica (estatisticos — parcial)",
    "7490103": "Servicos de agronomia e consultoria agricola e pecuaria (agronomos e tecnicos agricolas, CFA)",
    "7500100": "Atividades veterinarias (medicos veterinarios e zootecnistas, CRMV)",
    "8800900": "Servicos sociais sem alojamento (assistentes sociais — parcial)",
    "9101100": "Bibliotecas e arquivos (bibliotecarios)",
    "9102300": "Museus e exploracao de espacos artisticos (museologos)",
    "9313100": "Atividades de condicionamento fisico (profissionais de educacao fisica — parcial)"
} as unknown as Record<string, string>,
  gruposArt128: {
    saude: { divisoes: [86, 87], rotulo: "Servico de saude (art. 130 + Anexo III): reducao de 60% do IBS/CBS" },
    educacao: { cnaes: ["8511200","8512100","8513300","8520100","8531700","8532500","8541400","8542200"],
      rotulo: "Servico de educacao do Anexo II (art. 129): reducao de 60% — cursos livres, idiomas comuns e apoio (caixas escolares) ficam FORA" },
    cultura: { divisoes: [58, 59, 60, 90, 91, 92],
      rotulo: "Producao nacional artistica, cultural, de eventos, jornalistica ou audiovisual (art. 128, X): reducao de 60% — PARCIAL, verificar enquadramento" },
  },
  pesos: {
    elegivel_127: 40,
    elegivel_128: 45,
    decisao_simples: 30,
    cnae_suspeito: 20,
    cnae_mudou: 15,
  },
};
