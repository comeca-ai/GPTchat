/** MANTER EM SYNC com pipeline/radar/regras_tributarias.json.
 * FUNDAMENTADA: art. 127 (rol taxativo, 30%) x art. 128, II (saude, 60%).
 * Profissoes sem CNAE exclusivo (adm, economistas, estatisticos, agronomos,
 * tecnicos) ficam fora da deteccao automatica — nota para o contador.
 */
export const REGRAS = {
  regrasVersion: "2026-10-05.fundamentada",
  cnaesArt127: {
    "6911701": "Servicos advocaticios (advogados, OAB)",
    "6920601": "Atividades de contabilidade (contabilistas, CRC)",
    "7111100": "Servicos de arquitetura (arquitetos e urbanistas, CAU)",
    "7112000": "Servicos de engenharia (engenheiros, CREA)",
    "7500100": "Atividades veterinarias (medicos veterinarios e zootecnistas, CRMV)",
    "7120100": "Ensaios e analises tecnicas (quimicos, CRQ — parcial)",
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
