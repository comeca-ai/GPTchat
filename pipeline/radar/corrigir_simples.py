#!/usr/bin/env python3
"""Radar: reconstrui simples/mei do recorte a partir do arquivo bruto no R2.

Motivo: a RFB usa 00000000 como 'sem data de exclusao'; a extracao original
marcava optantes ativos como 'N'. Este job:
1. coleta as raizes do recorte a partir dos chunks no R2;
2. refaz o mapa raiz -> (simples, mei) lendo o Simples.zip do arquivo bruto;
3. regrava os chunks num build novo ({build}-fix1) com os campos corrigidos;
4. escreve o manifesto do build novo.
Depois: apagar as linhas do build antigo no D1 e rodar a carga com BUILD_ID novo.
"""
from __future__ import annotations

import csv
import io
import json
import sys
import tempfile
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from cnpj_schema import SCHEMAS  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parent))
from extrair_recorte import ping, required_env, s3_client  # noqa: E402

IDX_SIM = {n: i for i, n in enumerate(SCHEMAS["simples"])}


def main() -> None:
    if len(sys.argv) < 2:
        raise SystemExit("uso: corrigir_simples.py <build_id>")
    build = sys.argv[1]
    novo = build + "-fix1"
    env = required_env()
    s3 = s3_client(env)
    manifest = json.loads(s3.get_object(
        Bucket=env["R2_BUCKET"], Key=f"radar/builds/{build}/manifest.json")["Body"].read())
    comp = manifest["competencia"]

    # 1) raizes do recorte
    raizes: set[str] = set()
    for i, key in enumerate(manifest["chunks"], 1):
        corpo = s3.get_object(Bucket=env["R2_BUCKET"], Key=key)["Body"].read().decode()
        for linha in corpo.split("\n"):
            if linha.strip():
                raizes.add(json.loads(linha)["cnpj_raiz"])
        if i % 100 == 0:
            print(f".. raizes: {i}/{len(manifest['chunks'])} chunks", file=sys.stderr, flush=True)
    print(f"raizes no recorte: {len(raizes)}", file=sys.stderr)
    ping(fase="correcao_simples", etapa="raizes", raizes=len(raizes))

    # 2) mapa correto a partir do arquivo bruto
    obj = s3.get_object(Bucket=env["R2_BUCKET"], Key=f"radar/raw/{comp}/Simples.zip")
    dados = obj["Body"].read()
    correto: dict[str, tuple[str, str]] = {}
    with zipfile.ZipFile(io.BytesIO(dados)) as zf:
        for membro in zf.infolist():
            if membro.is_dir():
                continue
            with zf.open(membro) as fh:
                texto = io.TextIOWrapper(fh, encoding="iso-8859-1", newline="")
                for row in csv.reader(texto, delimiter=";", quotechar='"'):
                    if len(row) < len(SCHEMAS["simples"]):
                        continue
                    raiz = row[IDX_SIM["cnpj_basico"]]
                    if raiz not in raizes:
                        continue
                    opt = row[IDX_SIM["opcao_simples"]].strip()
                    mei = row[IDX_SIM["opcao_mei"]].strip()
                    exc = row[IDX_SIM["data_exclusao_simples"]].strip()
                    if opt == "S" and exc and exc != "00000000":
                        opt = "N"
                    correto[raiz] = (opt or None, mei or None)
    n_s = sum(1 for v in correto.values() if v[0] == "S")
    print(f"mapa corrigido: {len(correto)} raizes, {n_s} optantes S", file=sys.stderr)
    ping(fase="correcao_simples", etapa="mapa", optantes_s=n_s)

    # 3) regravar chunks no build novo
    novo_manifest = dict(manifest)
    novo_manifest["build_id"] = novo
    novo_manifest["correcao"] = "simples 00000000 (exclusao inexistente)"
    novos_chunks = []
    for i, key in enumerate(manifest["chunks"], 1):
        corpo = s3.get_object(Bucket=env["R2_BUCKET"], Key=key)["Body"].read().decode()
        linhas = []
        for linha in corpo.split("\n"):
            if not linha.strip():
                continue
            r = json.loads(linha)
            sim = correto.get(r["cnpj_raiz"])
            if sim:
                r["simples"], r["mei"] = sim
            linhas.append(json.dumps(r, ensure_ascii=False))
        nova_key = key.replace(f"/{build}/", f"/{novo}/")
        s3.put_object(Bucket=env["R2_BUCKET"], Key=nova_key,
                      Body="\n".join(linhas).encode(), ContentType="application/x-ndjson")
        novos_chunks.append(nova_key)
        if i % 50 == 0:
            print(f".. regravando: {i}/{len(manifest['chunks'])}", file=sys.stderr, flush=True)
            ping(fase="correcao_simples", etapa="regravando", chunks=i,
                 total_chunks=len(manifest["chunks"]))
    novo_manifest["chunks"] = novos_chunks
    s3.put_object(Bucket=env["R2_BUCKET"], Key=f"radar/builds/{novo}/manifest.json",
                  Body=json.dumps(novo_manifest, ensure_ascii=False, indent=2).encode(),
                  ContentType="application/json")
    ping(fase="correcao_simples_concluida", build_id=novo)
    print(json.dumps({"build_novo": novo, "chunks": len(novos_chunks),
                      "optantes_s": n_s}))


if __name__ == "__main__":
    main()
