/** MANTER EM SYNC com pipeline/radar/regras_tributarias.json.
 * FUNDAMENTADA v2: art. 127 (rol taxativo das 18 profissoes, 30%) x art. 128, II (saude, 60%).
 * 'parcial' = CNAE misto, revisar caso a caso. Administradores/economistas/RP:
 * sem CNAE seguro — deteccao manual (falso positivo certo se mapeados).
 */
export const REGRAS = {
  regrasVersion: "2026-10-05.fundamentada-v2",
  cnaesArt127: {
    "6911701": "Servicos advocaticios (advogados, OAB)",
    "6911702": "Atividades auxiliares da justica (pericia, mediacao/arbitragem — parcial)",
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
    "9313100": "Atividades de condicionamento fisico (profissionais de educacao fisica — parcial)",
  } as Record<string, string>,
  divisoesArt128Saude: [86, 87],
  pesos: {
    elegivel_127: 40,
    elegivel_128: 45,
    decisao_simples: 30,
    cnae_suspeito: 20,
    cnae_mudou: 15,
  },
};
