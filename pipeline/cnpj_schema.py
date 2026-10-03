"""Layout oficial dos arquivos de Dados Abertos do CNPJ."""

SCHEMAS: dict[str, list[str]] = {
    "empresas": [
        "cnpj_basico", "razao_social", "natureza_juridica",
        "qualificacao_responsavel", "capital_social", "porte",
        "ente_federativo",
    ],
    "estabelecimentos": [
        "cnpj_basico", "cnpj_ordem", "cnpj_dv", "matriz_filial",
        "nome_fantasia", "situacao_cadastral", "data_situacao",
        "motivo_situacao", "cidade_exterior", "pais", "data_inicio",
        "cnae_principal", "cnaes_secundarios", "tipo_logradouro",
        "logradouro", "numero", "complemento", "bairro", "cep", "uf",
        "municipio", "ddd1", "telefone1", "ddd2", "telefone2",
        "ddd_fax", "fax", "email", "situacao_especial",
        "data_situacao_especial",
    ],
    "socios": [
        "cnpj_basico", "tipo_socio", "nome_socio", "documento_socio",
        "qualificacao", "data_entrada", "pais", "representante_legal",
        "nome_representante", "qualificacao_representante", "faixa_etaria",
    ],
    "simples": [
        "cnpj_basico", "opcao_simples", "data_opcao_simples",
        "data_exclusao_simples", "opcao_mei", "data_opcao_mei",
        "data_exclusao_mei",
    ],
    "cnaes": ["codigo", "descricao"],
    "municipios": ["codigo", "descricao"],
    "naturezas": ["codigo", "descricao"],
    "motivos": ["codigo", "descricao"],
    "paises": ["codigo", "descricao"],
    "qualificacoes": ["codigo", "descricao"],
}

ALIASES = {
    "empre": "empresas",
    "estabele": "estabelecimentos",
    "socio": "socios",
    "simples": "simples",
    "cnae": "cnaes",
    "munic": "municipios",
    "natureza": "naturezas",
    "motivo": "motivos",
    "pais": "paises",
    "qualific": "qualificacoes",
}

CORE_TABLES = {"empresas", "estabelecimentos", "socios", "simples"}


def kind_from_name(name: str) -> str:
    low = name.lower()
    for fragment, kind in ALIASES.items():
        if fragment in low:
            return kind
    raise ValueError(f"tipo de arquivo desconhecido: {name}")
