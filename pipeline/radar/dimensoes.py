#!/usr/bin/env python3
"""Radar: baixa as tabelas de dimensao da Receita (CNAEs, Municipios,
Naturezas) e publica NDJSON no R2 para carga no D1."""
from __future__ import annotations

import csv
import io
import json
import os
import sys
import tempfile
import zipfile
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from cnpj_schema import SCHEMAS  # noqa: E402

from extrair_recorte import download, s3_client, required_env, url_nome  # noqa: E402

TABELAS = {
    "cnaes": "radar_cnaes",
    "municipios": "radar_municipios",
    "naturezas": "radar_naturezas",
}


def main() -> None:
    plan = json.loads(Path("plan.json").read_text())
    competencia = plan["snapshot"]
    env = required_env()
    s3 = s3_client(env)
    urls = {}
    for item in plan["include"]:
        if item["kind"] in TABELAS:
            urls[item["kind"]] = item["url"]
    faltando = set(TABELAS) - set(urls)
    if faltando:
        raise SystemExit(f"plano sem dimensoes: {sorted(faltando)}")

    with tempfile.TemporaryDirectory(prefix="radar-dims-") as tmp:
        for kind, url in urls.items():
            arc = Path(tmp) / "d.zip"
            download(url, arc)
            linhas = []
            with zipfile.ZipFile(arc) as zf:
                for member in zf.infolist():
                    if member.is_dir():
                        continue
                    with zf.open(member) as fh:
                        texto = io.TextIOWrapper(fh, encoding="iso-8859-1", newline="")
                        for row in csv.reader(texto, delimiter=";", quotechar='"'):
                            if len(row) >= 2 and row[0].strip():
                                linhas.append({"codigo": row[0].strip(),
                                               "descricao": row[1].strip()})
            arc.unlink()
            corpo = "\n".join(json.dumps(r, ensure_ascii=False) for r in linhas).encode()
            key = f"radar/dims/{competencia}/{TABELAS[kind]}.ndjson"
            s3.put_object(Bucket=env["R2_BUCKET"], Key=key, Body=corpo,
                          ContentType="application/x-ndjson")
            print(f"{kind}: {len(linhas)} linhas -> {key}", file=sys.stderr)
    print(json.dumps({"competencia": competencia, "tabelas": TABELAS}))


if __name__ == "__main__":
    main()
