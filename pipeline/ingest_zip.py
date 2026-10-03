#!/usr/bin/env python3
"""Baixa um ZIP oficial, preserva o bruto no R2 e grava uma tabela Iceberg."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import random
import re
import tempfile
import time
import zipfile
from pathlib import Path
from urllib.parse import unquote, urlparse

import boto3
import pyarrow as pa
import pyarrow.csv as pacsv
import requests
from botocore.exceptions import ClientError
from pyiceberg.catalog.rest import RestCatalog
from pyiceberg.exceptions import (
    CommitFailedException,
    NamespaceAlreadyExistsError,
    NoSuchTableError,
    TableAlreadyExistsError,
)

from cnpj_schema import SCHEMAS, kind_from_name


def required_env() -> dict[str, str]:
    names = [
        "R2_ENDPOINT", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET",
        "R2_CATALOG_URI", "R2_WAREHOUSE", "R2_CATALOG_TOKEN",
    ]
    missing = [name for name in names if not os.environ.get(name)]
    if missing:
        raise SystemExit("faltam variáveis: " + ", ".join(missing))
    return {name: os.environ[name] for name in names}


def namespace_for(snapshot: str) -> str:
    return "cnpj_" + snapshot.replace("-", "_")


def exists(s3, bucket: str, key: str) -> bool:
    try:
        s3.head_object(Bucket=bucket, Key=key)
        return True
    except ClientError as exc:
        if exc.response.get("Error", {}).get("Code") in {"404", "NoSuchKey", "NotFound"}:
            return False
        raise


def download(url: str, target: Path) -> None:
    headers = {"User-Agent": "GPTchat-CNPJ-ingestor/1.0"}
    if url.startswith("https://arquivos.receitafederal.gov.br/public.php/dav/"):
        headers["X-Requested-With"] = "XMLHttpRequest"
    with requests.get(
        url,
        stream=True,
        timeout=(30, 600),
        headers=headers,
    ) as response:
        response.raise_for_status()
        with target.open("wb") as output:
            for chunk in response.iter_content(8 * 1024 * 1024):
                if chunk:
                    output.write(chunk)


def arrow_schema(kind: str) -> pa.Schema:
    return pa.schema([pa.field(name, pa.string()) for name in SCHEMAS[kind]])


def open_reader(csv_path: Path, kind: str, counter: list[int]) -> pa.RecordBatchReader:
    schema = arrow_schema(kind)
    csv_reader = pacsv.open_csv(
        csv_path,
        read_options=pacsv.ReadOptions(
            column_names=SCHEMAS[kind], encoding="iso-8859-1", block_size=64 * 1024 * 1024,
        ),
        parse_options=pacsv.ParseOptions(delimiter=";", quote_char='"'),
        convert_options=pacsv.ConvertOptions(
            column_types={name: pa.string() for name in SCHEMAS[kind]},
            strings_can_be_null=True,
        ),
    )

    def batches():
        for batch in csv_reader:
            counter[0] += batch.num_rows
            yield batch

    return pa.RecordBatchReader.from_batches(schema, batches())


def load_or_create_table(catalog: RestCatalog, namespace: str, kind: str):
    try:
        catalog.create_namespace(namespace)
    except NamespaceAlreadyExistsError:
        pass
    identifier = (namespace, kind)
    try:
        return catalog.load_table(identifier)
    except NoSuchTableError:
        try:
            return catalog.create_table(
                identifier,
                schema=arrow_schema(kind),
                properties={
                    "write.format.default": "parquet",
                    "write.parquet.compression-codec": "zstd",
                    "write.target-file-size-bytes": str(128 * 1024 * 1024),
                },
            )
        except TableAlreadyExistsError:
            return catalog.load_table(identifier)


def already_committed(table, source_id: str) -> bool:
    for snapshot in table.snapshots():
        summary = snapshot.summary
        props = summary.additional_properties if summary else {}
        if props.get("source_id") == source_id:
            return True
    return False


def append_with_retry(catalog, namespace: str, kind: str, csv_path: Path, properties: dict[str, str]) -> int:
    for attempt in range(1, 6):
        table = load_or_create_table(catalog, namespace, kind)
        if already_committed(table, properties["source_id"]):
            return 0
        counter = [0]
        try:
            table.append(open_reader(csv_path, kind, counter), snapshot_properties=properties)
            return counter[0]
        except CommitFailedException:
            if attempt == 5:
                raise
            time.sleep((2 ** attempt) + random.random())
    raise AssertionError("tentativas esgotadas")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("url")
    parser.add_argument("--snapshot", required=True)
    args = parser.parse_args()
    if not re.fullmatch(r"\d{4}-\d{2}", args.snapshot):
        raise SystemExit("snapshot deve usar AAAA-MM")
    env = required_env()
    source_id = hashlib.sha256(args.url.encode()).hexdigest()[:20]
    marker_key = f"snapshots/{args.snapshot}/ingest/{source_id}.json"
    s3 = boto3.client(
        "s3", endpoint_url=env["R2_ENDPOINT"],
        aws_access_key_id=env["R2_ACCESS_KEY_ID"],
        aws_secret_access_key=env["R2_SECRET_ACCESS_KEY"], region_name="auto",
    )
    if exists(s3, env["R2_BUCKET"], marker_key):
        print(f"skip: {args.url}")
        return
    catalog = RestCatalog(
        name="cloudflare", warehouse=env["R2_WAREHOUSE"],
        uri=env["R2_CATALOG_URI"], token=env["R2_CATALOG_TOKEN"],
    )
    namespace = namespace_for(args.snapshot)
    archive_name = unquote(urlparse(args.url).path.rsplit("/", 1)[-1])
    raw_key = f"snapshots/{args.snapshot}/raw/{archive_name}"
    processed: list[dict[str, object]] = []
    with tempfile.TemporaryDirectory(prefix="cnpj-") as tmp:
        root = Path(tmp)
        archive = root / "source.zip"
        download(args.url, archive)
        if not exists(s3, env["R2_BUCKET"], raw_key):
            s3.upload_file(
                str(archive), env["R2_BUCKET"], raw_key,
                ExtraArgs={"ContentType": "application/zip", "Metadata": {"source": args.url, "snapshot": args.snapshot}},
            )
        with zipfile.ZipFile(archive) as zf:
            members = [member for member in zf.infolist() if not member.is_dir()]
            if not members:
                raise RuntimeError(f"ZIP vazio: {args.url}")
            for member in members:
                kind = kind_from_name(f"{archive_name} {member.filename}")
                csv_path = Path(zf.extract(member, root))
                rows = append_with_retry(
                    catalog, namespace, kind, csv_path,
                    {"source_id": source_id, "source_url": args.url, "snapshot_id": args.snapshot},
                )
                processed.append({"table": kind, "member": member.filename, "rows": rows})
    marker = {
        "snapshot": args.snapshot, "namespace": namespace, "source": args.url,
        "source_id": source_id, "raw_key": raw_key, "processed": processed,
    }
    s3.put_object(
        Bucket=env["R2_BUCKET"], Key=marker_key,
        Body=json.dumps(marker, ensure_ascii=False).encode(),
        ContentType="application/json", CacheControl="no-store",
    )
    print(json.dumps(marker, ensure_ascii=False))


if __name__ == "__main__":
    main()
