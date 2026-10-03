#!/usr/bin/env python3
"""Valida todos os lotes e promove o snapshot ativo no R2 de forma atômica."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from datetime import datetime, timezone
from pathlib import Path

import boto3
from pyiceberg.catalog.rest import RestCatalog

from cnpj_schema import CORE_TABLES
from ingest_zip import namespace_for, required_env


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("plan", type=Path)
    args = parser.parse_args()
    plan = json.loads(args.plan.read_text())
    snapshot = plan["snapshot"]
    env = required_env()
    s3 = boto3.client(
        "s3", endpoint_url=env["R2_ENDPOINT"],
        aws_access_key_id=env["R2_ACCESS_KEY_ID"],
        aws_secret_access_key=env["R2_SECRET_ACCESS_KEY"], region_name="auto",
    )
    markers: list[dict] = []
    missing: list[str] = []
    for item in plan["include"]:
        source_id = hashlib.sha256(item["url"].encode()).hexdigest()[:20]
        key = f"snapshots/{snapshot}/ingest/{source_id}.json"
        try:
            body = s3.get_object(Bucket=env["R2_BUCKET"], Key=key)["Body"].read()
            markers.append(json.loads(body))
        except s3.exceptions.NoSuchKey:
            missing.append(item["url"])
    if missing:
        raise SystemExit("lotes ausentes:\n" + "\n".join(missing))

    namespace = namespace_for(snapshot)
    catalog = RestCatalog(
        name="cloudflare", warehouse=env["R2_WAREHOUSE"],
        uri=env["R2_CATALOG_URI"], token=env["R2_CATALOG_TOKEN"],
    )
    tables = {entry["table"] for marker in markers for entry in marker["processed"]}
    missing_tables = CORE_TABLES - tables
    if missing_tables:
        raise SystemExit("tabelas essenciais ausentes: " + ", ".join(sorted(missing_tables)))
    for table in sorted(tables):
        catalog.load_table((namespace, table))

    row_counts: dict[str, int] = {}
    for marker in markers:
        for entry in marker["processed"]:
            table = entry["table"]
            row_counts[table] = row_counts.get(table, 0) + int(entry.get("rows", 0))
    manifest = {
        "status": "ready", "snapshot": snapshot, "namespace": namespace,
        "published_at": datetime.now(timezone.utc).isoformat(),
        "source": plan["source"], "public_share": plan["public_share"],
        "files": len(markers), "tables": sorted(tables), "row_counts": row_counts,
    }
    encoded = json.dumps(manifest, ensure_ascii=False, separators=(",", ":")).encode()
    s3.put_object(
        Bucket=env["R2_BUCKET"], Key=f"snapshots/{snapshot}/manifest.json",
        Body=encoded, ContentType="application/json", CacheControl="public,max-age=31536000,immutable",
    )
    # A última escrita é o ponteiro atômico consumido pelo Worker.
    s3.put_object(
        Bucket=env["R2_BUCKET"], Key="catalog/active.json",
        Body=encoded, ContentType="application/json", CacheControl="no-cache",
    )
    print(json.dumps(manifest, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
