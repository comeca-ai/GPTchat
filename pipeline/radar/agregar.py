#!/usr/bin/env python3
"""Radar: agrega o recorte publicado no R2 em estatisticas de oportunidade.

Le os chunks NDJSON do build ativo e produz radar/aggs/{build_id}.json:
- totais e contagem por flag (elegivel_127, decisao_simples, cnae_suspeito)
- por CNAE principal: n, simples, elegiveis_127
- por divisao CNAE, por municipio, por porte
Roda na VPS (ou qualquer maquina com acesso ao R2)."""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from extrair_recorte import ping, required_env, s3_client  # noqa: E402


def main() -> None:
    env = required_env()
    s3 = s3_client(env)
    build_id = sys.argv[1] if len(sys.argv) > 1 else None
    if not build_id:
        raise SystemExit("uso: agregar.py <build_id>")
    regras = json.loads(Path(__file__).with_name("regras_tributarias.json").read_text())
    art127 = set(regras["cnaes_art127"])

    manifest = json.loads(s3.get_object(
        Bucket=env["R2_BUCKET"],
        Key=f"radar/builds/{build_id}/manifest.json")["Body"].read())

    def novo():
        return {"n": 0, "simples": 0, "mei": 0, "eleg127": 0}

    por_cnae: dict[str, dict] = {}
    por_divisao: dict[str, dict] = {}
    por_municipio: dict[str, dict] = {}
    por_porte: dict[str, dict] = {}
    flags = {"elegivel_127": 0, "decisao_simples": 0, "cnae_suspeito": 0}
    total = 0

    def conta(mapa, chave, simples, mei, eleg):
        d = mapa.setdefault(chave, novo())
        d["n"] += 1
        d["simples"] += simples
        d["mei"] += mei
        d["eleg127"] += eleg

    for i, key in enumerate(manifest["chunks"], 1):
        corpo = s3.get_object(Bucket=env["R2_BUCKET"], Key=key)["Body"].read().decode()
        for linha in corpo.split("\n"):
            if not linha.strip():
                continue
            r = json.loads(linha)
            total += 1
            cnae = r.get("cnae_principal") or ""
            sec = r.get("cnaes_secundarios") or ""
            sim = 1 if r.get("simples") == "S" else 0
            mei = 1 if r.get("mei") == "S" else 0
            eleg = 1 if cnae in art127 else 0
            if eleg:
                flags["elegivel_127"] += 1
            if sim:
                flags["decisao_simples"] += 1
            if not eleg and any(s.strip() in art127 for s in sec.split(",") if s.strip()):
                flags["cnae_suspeito"] += 1
            conta(por_cnae, cnae, sim, mei, eleg)
            conta(por_divisao, cnae[:2] or "??", sim, mei, eleg)
            conta(por_municipio, r.get("municipio_codigo") or "?", sim, mei, eleg)
            conta(por_porte, r.get("porte") or "?", sim, mei, eleg)
        if i % 50 == 0:
            print(f".. {i}/{len(manifest['chunks'])} chunks, {total} linhas",
                  file=sys.stderr, flush=True)
            ping(fase="agregando", chunks=i, total_chunks=len(manifest["chunks"]))

    agg = {
        "build_id": build_id, "competencia": manifest.get("competencia"),
        "uf": manifest.get("uf"), "total": total, "flags": flags,
        "por_cnae": por_cnae, "por_divisao": por_divisao,
        "por_municipio": por_municipio, "por_porte": por_porte,
    }
    s3.put_object(Bucket=env["R2_BUCKET"], Key=f"radar/aggs/{build_id}.json",
                  Body=json.dumps(agg, ensure_ascii=False).encode(),
                  ContentType="application/json")

    # snapshot pre-renderizado do painel (descricoes ja fundidas -> Worker so serve)
    def dims(tabela):
        try:
            corpo = s3.get_object(Bucket=env["R2_BUCKET"],
                                  Key=f"radar/dims/{manifest.get('competencia')}/{tabela}.ndjson"
                                  )["Body"].read().decode()
            return {json.loads(l)["codigo"]: json.loads(l)["descricao"]
                    for l in corpo.split("\n") if l.strip()}
        except Exception:
            return {}

    cnae_desc = dims("radar_cnaes")
    mun_desc = dims("radar_municipios")
    painel = {
        "build_id": build_id, "competencia": manifest.get("competencia"),
        "total": total, "flags": flags, "por_porte": por_porte,
        "top_cnaes": [
            {"codigo": c, "descricao": cnae_desc.get(c, ""), **d}
            for c, d in sorted(por_cnae.items(), key=lambda kv: -kv[1]["n"])[:100]
        ],
        "top_municipios": [
            {"codigo": m, "nome": mun_desc.get(m, m), **d}
            for m, d in sorted(por_municipio.items(), key=lambda kv: -kv[1]["n"])[:100]
        ],
    }
    s3.put_object(Bucket=env["R2_BUCKET"], Key=f"radar/aggs/{build_id}-painel.json",
                  Body=json.dumps(painel, ensure_ascii=False).encode(),
                  ContentType="application/json")
    print(f"snapshot do painel gravado: radar/aggs/{build_id}-painel.json", file=sys.stderr)
    ping(fase="agregacao_concluida", build_id=build_id, total=total)
    print(json.dumps({"build_id": build_id, "total": total, "flags": flags,
                      "cnaes": len(por_cnae), "municipios": len(por_municipio)}))


if __name__ == "__main__":
    main()
