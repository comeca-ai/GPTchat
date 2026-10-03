#!/usr/bin/env python3
"""Descobre os ZIPs mensais no compartilhamento público oficial da RFB."""
from __future__ import annotations

import argparse
import json
import re
import sys
import xml.etree.ElementTree as ET
from urllib.parse import quote, unquote, urlparse
from urllib.error import URLError
from urllib.request import Request, urlopen

from cnpj_schema import CORE_TABLES, kind_from_name

ORIGIN = "https://arquivos.receitafederal.gov.br"
SHARE_TOKEN = "YggdBLfdninEJX9"
DAV_ROOT = f"{ORIGIN}/public.php/dav/files/{SHARE_TOKEN}/"
PUBLIC_SHARE = f"{ORIGIN}/index.php/s/{SHARE_TOKEN}"
DATASET_PAGE = "https://dados.gov.br/dados/conjuntos-dados/cadastro-nacional-da-pessoa-juridica---cnpj"
DAV = "{DAV:}"
PROPFIND_BODY = """<?xml version="1.0" encoding="UTF-8"?>
<d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/><d:getlastmodified/></d:prop></d:propfind>
"""
HEADERS = {
    "User-Agent": "GPTchat-CNPJ-ingestor/1.0",
    "X-Requested-With": "XMLHttpRequest",
}


def dav_url(path: str = "", *, directory: bool = True) -> str:
    clean = path.strip("/")
    suffix = quote(clean, safe="/")
    if directory and suffix:
        suffix += "/"
    return DAV_ROOT + suffix


def parse_dav_entries(xml: str) -> list[dict[str, object]]:
    """Converte um DAV multistatus em nomes e tipos, ignorando metadados extras."""
    root = ET.fromstring(xml)
    entries: list[dict[str, object]] = []
    for response in root.findall(f"{DAV}response"):
        href = response.findtext(f"{DAV}href") or ""
        path = unquote(urlparse(href).path).rstrip("/")
        name = path.rsplit("/", 1)[-1]
        is_collection = response.find(f".//{DAV}resourcetype/{DAV}collection") is not None
        if name:
            entries.append({"name": name, "is_collection": is_collection})
    return entries


def list_dav(path: str = "") -> list[dict[str, object]]:
    request = Request(
        dav_url(path),
        data=PROPFIND_BODY.encode(),
        method="PROPFIND",
        headers={**HEADERS, "Depth": "1", "Content-Type": "application/xml; charset=utf-8"},
    )
    with urlopen(request, timeout=120) as response:
        return parse_dav_entries(response.read().decode("utf-8"))


def available_snapshots() -> list[str]:
    snapshots = {
        str(entry["name"])
        for entry in list_dav()
        if entry["is_collection"] and re.fullmatch(r"\d{4}-(0[1-9]|1[0-2])", str(entry["name"]))
    }
    return sorted(snapshots, reverse=True)


def discover(snapshot: str) -> list[dict[str, str]]:
    found: dict[str, dict[str, str]] = {}
    for entry in list_dav(snapshot):
        name = str(entry["name"])
        if entry["is_collection"] or not name.lower().endswith(".zip"):
            continue
        try:
            kind = kind_from_name(name)
        except ValueError:
            continue
        url = dav_url(f"{snapshot}/{name}", directory=False)
        found[url] = {"url": url, "kind": kind, "name": name}
    items = sorted(found.values(), key=lambda item: (item["kind"], item["name"]))
    missing = CORE_TABLES - {item["kind"] for item in items}
    if missing:
        raise RuntimeError(f"competência {snapshot} incompleta; faltam {sorted(missing)}")
    return items


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--snapshot", help="competência AAAA-MM; omita para descobrir a mais recente")
    args = parser.parse_args()
    if args.snapshot and not re.fullmatch(r"\d{4}-(0[1-9]|1[0-2])", args.snapshot):
        raise SystemExit("snapshot deve usar AAAA-MM")
    try:
        candidates = [args.snapshot] if args.snapshot else available_snapshots()
    except (OSError, URLError) as exc:
        raise SystemExit(f"não foi possível listar a fonte oficial: {exc}") from exc
    failures: list[str] = []
    for snapshot in candidates:
        try:
            files = discover(snapshot)
            plan = {
                "snapshot": snapshot,
                "source": DATASET_PAGE,
                "public_share": PUBLIC_SHARE,
                "include": files,
            }
            print(json.dumps(plan, separators=(",", ":")))
            print(f"{snapshot}: {len(files)} ZIPs oficiais", file=sys.stderr)
            return
        except (OSError, URLError, RuntimeError) as exc:
            failures.append(f"{snapshot}: {exc}")
    raise SystemExit("nenhuma competência completa encontrada\n" + "\n".join(failures))


if __name__ == "__main__":
    main()
