#!/usr/bin/env python3
"""Radar: preserva TODOS os ZIPs oficiais da competencia no R2 (arquivo bruto).

- Pula arquivos ja presentes com o mesmo tamanho (idempotente).
- Download com retomada (reusa download() de extrair_recorte).
- SHA-256 local registrado no manifesto (identidade do arquivo recebido).
- Heartbeat em radar/status/atual.json para o painel /radar.
"""
from __future__ import annotations

import hashlib
import json
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from extrair_recorte import download, ping, required_env, s3_client, url_nome  # noqa: E402
from botocore.exceptions import ClientError  # noqa: E402


def main() -> None:
    plan = json.loads(Path("plan.json").read_text())
    comp = plan["snapshot"]
    env = required_env()
    s3 = s3_client(env)
    itens = plan["include"]
    manifest = {"competencia": comp, "arquivos": [], "inicio": time.time()}
    print(f"arquivamento: {len(itens)} ZIPs da competencia {comp}", file=sys.stderr)

    with tempfile.TemporaryDirectory(prefix="radar-raw-", dir=None) as tmp:
        alvo = Path(tmp) / "f.zip"
        for i, item in enumerate(itens, 1):
            url, nome = item["url"], url_nome(item["url"])
            key = f"radar/raw/{comp}/{nome}"
            try:
                head = s3.head_object(Bucket=env["R2_BUCKET"], Key=key)
                remoto = head["ContentLength"]
            except ClientError:
                remoto = -1
            if remoto > 0:
                print(f"[{i}/{len(itens)}] skip {nome} (ja no R2, {remoto/1e6:.0f} MB)",
                      file=sys.stderr)
                manifest["arquivos"].append({"nome": nome, "key": key, "status": "existente"})
                continue
            ping(fase="arquivo_bruto", arquivo=nome, indice=i, total=len(itens))
            if alvo.exists():
                alvo.unlink()
            t0 = time.monotonic()
            download(url, alvo)
            sha = hashlib.sha256(alvo.read_bytes()).hexdigest()
            s3.upload_file(str(alvo), env["R2_BUCKET"], key,
                           ExtraArgs={"Metadata": {"sha256": sha, "fonte": url, "competencia": comp}})
            alvo.unlink()
            manifest["arquivos"].append({
                "nome": nome, "key": key, "sha256": sha,
                "bytes": alvo.stat().st_size if alvo.exists() else None,
                "status": "arquivado",
            })
            print(f"[{i}/{len(itens)}] {nome} arquivado em {time.monotonic()-t0:.0f}s",
                  file=sys.stderr)

    manifest["fim"] = time.time()
    s3.put_object(Bucket=env["R2_BUCKET"], Key=f"radar/raw/{comp}/manifest-raw.json",
                  Body=json.dumps(manifest, ensure_ascii=False, indent=2).encode(),
                  ContentType="application/json")
    ping(fase="arquivo_bruto_concluido", arquivos=len(itens))
    print(json.dumps({"competencia": comp, "arquivados": len(itens)}))


if __name__ == "__main__":
    main()
