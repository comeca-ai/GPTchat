#!/usr/bin/env python3
"""Radar v0: extrai recorte filtrado da Receita em fluxo e publica chunks no R2.

Principios (ver spec da POC):
- Nunca descompacta CSV inteiro em disco: o ZIP e baixado para arquivo
  temporario, mas o CSV interno e lido em streaming linha a linha.
- Recorte: UF alvo + situacao ativa (02) + CNAE de servico (divisoes do
  arquivo de regras), no principal ou em qualquer secundario.
- Join com Empresas (porte, natureza) e Simples (optante/MEI) pela raiz.
- Saida: chunks NDJSON em radar/builds/{build_id}/load/ + manifest.json
  + quality.json. Nada e escrito em D1 aqui; a carga e via Worker.
- Modo --ensaio: processa somente o primeiro ZIP de Estabelecimentos,
  mede tempo/disco/linhas e projeta o custo da carga completa.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import os
import sys
import tempfile
import time
import zipfile
from pathlib import Path
from urllib.parse import unquote, urlparse

import boto3
import requests

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from cnpj_schema import SCHEMAS, kind_from_name  # noqa: E402

IDX_ESTAB = {name: i for i, name in enumerate(SCHEMAS["estabelecimentos"])}
IDX_EMP = {name: i for i, name in enumerate(SCHEMAS["empresas"])}
IDX_SIM = {name: i for i, name in enumerate(SCHEMAS["simples"])}

CHUNK_SIZE = 10_000
USER_AGENT = "GPTchat-CNPJ-ingestor/1.0"


def required_env() -> dict[str, str]:
    names = ["R2_ENDPOINT", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"]
    missing = [n for n in names if not os.environ.get(n)]
    if missing:
        raise SystemExit("faltam variaveis: " + ", ".join(missing))
    return {n: os.environ[n] for n in names}


def s3_client(env):
    return boto3.client(
        "s3", endpoint_url=env["R2_ENDPOINT"],
        aws_access_key_id=env["R2_ACCESS_KEY_ID"],
        aws_secret_access_key=env["R2_SECRET_ACCESS_KEY"], region_name="auto",
    )


def download(url: str, target: Path) -> float:
    headers = {"User-Agent": USER_AGENT}
    if "arquivos.receitafederal.gov.br/public.php/dav/" in url:
        headers["X-Requested-With"] = "XMLHttpRequest"
    start = time.monotonic()
    nome = url_nome(url)
    baixado = 0
    with requests.get(url, stream=True, timeout=(30, 900), headers=headers) as r:
        r.raise_for_status()
        total = int(r.headers.get("content-length") or 0)
        with target.open("wb") as out:
            for chunk in r.iter_content(8 * 1024 * 1024):
                if not chunk:
                    continue
                out.write(chunk)
                baixado += len(chunk)
                if baixado % (64 * 1024 * 1024) < 8 * 1024 * 1024:
                    mb = baixado / 1024 / 1024
                    vel = mb / max(time.monotonic() - start, 0.1)
                    tam = f"/{total/1024/1024:.0f}" if total else ""
                    print(f"  .. {nome}: {mb:.0f}{tam} MB ({vel:.1f} MB/s)",
                          file=sys.stderr, flush=True)
    return time.monotonic() - start


def rows_of_zip(zip_path: Path):
    """Gera linhas de todos os membros CSV do ZIP, em fluxo."""
    with zipfile.ZipFile(zip_path) as zf:
        for member in zf.infolist():
            if member.is_dir():
                continue
            with zf.open(member) as fh:
                text = io.TextIOWrapper(fh, encoding="iso-8859-1", newline="")
                reader = csv.reader(text, delimiter=";", quotechar='"')
                yield from reader


def divisao(cnae: str) -> int | None:
    try:
        return int(cnae[:2])
    except (ValueError, IndexError):
        return None


def no_recorte(linha, uf: str, regras) -> bool:
    est = IDX_ESTAB
    if (linha[est["uf"]] or "").strip() != uf:
        return False
    if (linha[est["situacao_cadastral"]] or "").strip() != "02":
        return False
    f = regras["filtro_recorte"]
    lo, hi = f["divisao_min"], f["divisao_max"]
    excluir = set(f["divisoes_cnae_excluir"])

    def ok(cnae: str) -> bool:
        d = divisao(cnae)
        return d is not None and lo <= d <= hi and d not in excluir

    if ok((linha[est["cnae_principal"]] or "").strip()):
        return True
    sec = (linha[est["cnaes_secundarios"]] or "").strip()
    return any(ok(s) for s in sec.split(",") if s.strip())


def url_nome(url: str) -> str:
    return unquote(urlparse(url).path.rsplit("/", 1)[-1])


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--plan", type=Path, required=True, help="plan.json do discover_rfb.py")
    ap.add_argument("--uf", default="SP")
    ap.add_argument("--regras", type=Path, default=Path(__file__).parent / "regras_tributarias.json")
    ap.add_argument("--ensaio", action="store_true", help="mede um fragmento e encerra com projecao")
    args = ap.parse_args()

    plan = json.loads(args.plan.read_text())
    competencia = plan["snapshot"]
    regras = json.loads(args.regras.read_text())
    env = required_env()
    s3 = s3_client(env)

    por_tipo: dict[str, list[str]] = {}
    for item in plan["include"]:
        if item["kind"] in {"estabelecimentos", "empresas", "simples"}:
            por_tipo.setdefault(item["kind"], []).append(item["url"])
    for tipo in ("estabelecimentos", "empresas", "simples"):
        if tipo not in por_tipo:
            raise SystemExit(f"plano sem {tipo}; recorte exige os tres")

    build_hash = hashlib.sha256(
        json.dumps([competencia, args.uf, regras["regras_version"]]).encode()
    ).hexdigest()[:8]
    build_id = f"{competencia}-{args.uf}-{build_hash}"
    prefixo = f"radar/builds/{build_id}"
    qualidade = {
        "build_id": build_id, "competencia": competencia, "uf": args.uf,
        "regras_version": regras["regras_version"], "ensaio": args.ensaio,
        "etapas": [],
    }
    print(f"build_id={build_id}", file=sys.stderr)

    def etapa(nome, **dados):
        qualidade["etapas"].append({"etapa": nome, **dados})
        print(f"[{nome}] {dados}", file=sys.stderr)

    with tempfile.TemporaryDirectory(prefix="radar-") as tmp:
        root = Path(tmp)

        # Fase 1: Estabelecimentos -> filtro em fluxo, spool em disco + raizes
        spool = root / "recorte.csv"
        raizes: set[str] = set()
        total_lidas = 0
        zips_estab = por_tipo["estabelecimentos"][:1] if args.ensaio else por_tipo["estabelecimentos"]
        with spool.open("w", encoding="utf-8", newline="") as out:
            writer = csv.writer(out, delimiter=";")
            for url in zips_estab:
                nome = url_nome(url)
                t0 = time.monotonic()
                arc = root / "fonte.zip"
                t_down = download(url, arc)
                lidas = mantidas = 0
                for linha in rows_of_zip(arc):
                    lidas += 1
                    if lidas % 1_000_000 == 0:
                        print(f"  .. {nome}: {lidas/1e6:.0f}M linhas lidas, "
                              f"{mantidas} no recorte", file=sys.stderr, flush=True)
                    if len(linha) < len(SCHEMAS["estabelecimentos"]):
                        continue
                    if no_recorte(linha, args.uf, regras):
                        mantidas += 1
                        raizes.add(linha[IDX_ESTAB["cnpj_basico"]])
                        writer.writerow(linha)
                arc.unlink()
                total_lidas += lidas
                etapa("estabelecimentos", arquivo=nome, linhas=lidas, mantidas=mantidas,
                      download_s=round(t_down, 1), total_s=round(time.monotonic() - t0, 1))

        if args.ensaio:
            n = len(por_tipo["estabelecimentos"])
            e = qualidade["etapas"][-1]
            qualidade["projecao_completa"] = {
                "zips_estabelecimentos": n,
                "tempo_estimado_min": round(e["total_s"] * n / 60, 1),
                "linhas_estimadas_recorte": e["mantidas"] * n,
                "observacao": "projecao linear grosseira; medir antes de escalar (spec secao 7)",
            }
            s3.put_object(Bucket=env["R2_BUCKET"], Key=f"{prefixo}/quality-ensaio.json",
                          Body=json.dumps(qualidade, ensure_ascii=False, indent=2).encode(),
                          ContentType="application/json")
            print(json.dumps(qualidade, ensure_ascii=False, indent=2))
            return

        # Fase 2: Empresas das raizes do recorte
        empresas: dict[str, tuple[str, str, str]] = {}
        for url in por_tipo["empresas"]:
            arc = root / "fonte.zip"
            download(url, arc)
            for linha in rows_of_zip(arc):
                if len(linha) < len(SCHEMAS["empresas"]):
                    continue
                raiz = linha[IDX_EMP["cnpj_basico"]]
                if raiz in raizes:
                    empresas[raiz] = (linha[IDX_EMP["razao_social"]],
                                      linha[IDX_EMP["porte"]], linha[IDX_EMP["natureza_juridica"]])
            arc.unlink()
        etapa("empresas", raizes_recorte=len(raizes), encontradas=len(empresas))

        # Fase 3: Simples das raizes do recorte
        simples: dict[str, tuple[str, str]] = {}
        for url in por_tipo["simples"]:
            arc = root / "fonte.zip"
            download(url, arc)
            for linha in rows_of_zip(arc):
                if len(linha) < len(SCHEMAS["simples"]):
                    continue
                raiz = linha[IDX_SIM["cnpj_basico"]]
                if raiz in raizes:
                    opt = linha[IDX_SIM["opcao_simples"]].strip()
                    mei = linha[IDX_SIM["opcao_mei"]].strip()
                    if opt == "S" and linha[IDX_SIM["data_exclusao_simples"]].strip():
                        opt = "N"
                    simples[raiz] = (opt or None, mei or None)
            arc.unlink()
        etapa("simples", encontradas=len(simples))

        # Fase 4: join + chunks NDJSON -> R2
        est = IDX_ESTAB
        chunks: list[str] = []
        buf: list[dict] = []
        escritas = sem_empresa = 0

        def flush():
            nonlocal buf
            if not buf:
                return
            idx = len(chunks) + 1
            key = f"{prefixo}/load/estabelecimentos/chunk-{idx:05d}.ndjson"
            corpo = "\n".join(json.dumps(r, ensure_ascii=False) for r in buf).encode()
            s3.put_object(Bucket=env["R2_BUCKET"], Key=key, Body=corpo,
                          ContentType="application/x-ndjson")
            chunks.append(key)
            buf = []

        with spool.open(encoding="utf-8", newline="") as fh:
            for linha in csv.reader(fh, delimiter=";"):
                raiz = linha[est["cnpj_basico"]]
                emp = empresas.get(raiz)
                if emp is None:
                    sem_empresa += 1
                    razao, porte, natureza = "", None, None
                else:
                    razao, porte, natureza = emp
                sim = simples.get(raiz, (None, None))
                buf.append({
                    "cnpj": linha[est["cnpj_basico"]] + linha[est["cnpj_ordem"]] + linha[est["cnpj_dv"]],
                    "cnpj_raiz": raiz,
                    "razao_social": razao or linha[est["nome_fantasia"]] or "",
                    "nome_fantasia": linha[est["nome_fantasia"]] or None,
                    "matriz_filial": linha[est["matriz_filial"]],
                    "cnae_principal": linha[est["cnae_principal"]],
                    "cnaes_secundarios": linha[est["cnaes_secundarios"]] or None,
                    "uf": linha[est["uf"]],
                    "municipio_codigo": linha[est["municipio"]] or None,
                    "porte": porte,
                    "natureza_juridica": natureza,
                    "data_inicio": linha[est["data_inicio"]] or None,
                    "simples": sim[0],
                    "mei": sim[1],
                })
                escritas += 1
                if len(buf) >= CHUNK_SIZE:
                    flush()
            flush()

        cobertura = round(100 * len(empresas) / len(raizes), 2) if raizes else 0.0
        manifest = {
            "build_id": build_id, "competencia": competencia, "uf": args.uf,
            "regras_version": regras["regras_version"],
            "chunks": chunks, "total_registros": escritas,
            "source": plan.get("source"), "public_share": plan.get("public_share"),
        }
        qualidade["resumo"] = {
            "registros": escritas, "raizes": len(raizes), "chunks": len(chunks),
            "cobertura_empresas_pct": cobertura, "sem_empresa": sem_empresa,
        }
        etapa("carga", **qualidade["resumo"])
        if cobertura < 99.5:
            qualidade["alerta"] = "cobertura de Empresas abaixo de 99,5% (limiar da spec)"
        for nome, corpo in (("manifest.json", manifest), ("quality.json", qualidade)):
            s3.put_object(Bucket=env["R2_BUCKET"], Key=f"{prefixo}/{nome}",
                          Body=json.dumps(corpo, ensure_ascii=False, indent=2).encode(),
                          ContentType="application/json")
        print(json.dumps(manifest, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
