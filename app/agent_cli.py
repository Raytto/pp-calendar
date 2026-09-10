"""PPHK host-only Calendar API client. No password or persistent browser cookie required.

Creates a short-lived local session as root, sends business changes through the API,
and revokes the session on exit. It is not a cross-tenant/public authentication API.
"""
from __future__ import annotations

import argparse
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import secrets
import sqlite3
import subprocess
import sys
import time
from urllib.error import HTTPError
from urllib.parse import urlencode, urlparse
from urllib.request import Request, urlopen


@contextmanager
def local_session(database: Path):
    token, csrf = secrets.token_urlsafe(40), secrets.token_urlsafe(32)
    digest = hashlib.sha256(token.encode()).hexdigest()
    with sqlite3.connect(f"file:{database}?mode=rw", uri=True, timeout=10) as connection:
        connection.execute("DELETE FROM sessions WHERE expires_at<?", (int(time.time()),))
        connection.execute(
            "INSERT INTO sessions(token_hash,csrf_token,expires_at,created_at) VALUES(?,?,?,datetime('now'))",
            (digest, csrf, int(time.time()) + 600),
        )
    try:
        yield token, csrf
    finally:
        with sqlite3.connect(f"file:{database}?mode=rw", uri=True, timeout=10) as connection:
            connection.execute("DELETE FROM sessions WHERE token_hash=?", (digest,))


class CalendarClient:
    def __init__(self, base: str, token: str, csrf: str):
        self.base, self.token, self.csrf = base.rstrip("/"), token, csrf

    def request(self, method: str, path: str, payload=None, *, content=None, key=None, binary=False):
        headers = {"Cookie": f"pp_calendar_session={self.token}", "X-CSRF-Token": self.csrf}
        if payload is not None:
            content = json.dumps(payload, ensure_ascii=False).encode()
            headers["Content-Type"] = "application/json"
        elif content is not None:
            headers["Content-Type"] = "application/octet-stream"
        if key:
            headers["Idempotency-Key"] = key
        try:
            with urlopen(Request(self.base + path, data=content, headers=headers, method=method), timeout=120) as response:
                data = response.read()
                return data if binary else json.loads(data)
        except HTTPError as error:
            try:
                message = json.loads(error.read()).get("error", "接口拒绝请求")
            except (ValueError, AttributeError):
                message = "接口拒绝请求"
            raise RuntimeError(f"HTTP {error.code}: {message}") from None

    def upload(self, event_id: int, path: Path):
        if not path.is_file() or not 0 < path.stat().st_size <= 20 * 1024 * 1024:
            raise ValueError("图片必须是非空普通文件，且不超过 20 MiB")
        return self.request("POST", f"/api/events/{event_id}/images?" + urlencode({"name": path.name[:200]}), content=path.read_bytes())


def perform(client: CalendarClient, args):
    command = args.command
    if command == "calendars":
        return client.request("GET", "/api/calendars")
    if command == "events":
        rows, page = [], 1
        while True:
            query = urlencode({"start": args.start, "end": args.end, "q": args.query or "", "page": page})
            result = client.request("GET", "/api/events?" + query)
            rows.extend(result["events"])
            if not (result.get("pagination") or {}).get("has_next"):
                return {"events": rows, "count": len(rows)}
            page += 1
    if command == "get":
        result = client.request("GET", f"/api/events/{args.id}")
        result.update(client.request("GET", f"/api/events/{args.id}/images"))
        return result
    if command in ("create", "update"):
        payload = json.loads(args.payload_file.read_text(encoding="utf-8-sig"))
        if command == "create":
            result = client.request("POST", "/api/events", payload, key=args.request_id)
        else:
            result = client.request("PATCH", f"/api/events/{args.id}", payload)
        event_id = result["event"]["id"]
        errors = []
        for path in args.image:
            try:
                client.upload(event_id, path)
            except (OSError, ValueError, RuntimeError) as error:
                errors.append({"file": path.name, "error": str(error)})
        result["images"] = client.request("GET", f"/api/events/{event_id}/images")["images"]
        result["image_errors"] = errors
        result["complete"] = not errors
        item = result["event"]
        year, month, _ = item["event_date"].split("-")
        result["url"] = f"https://calendar.pangruitao.com/month/{int(year)}/{int(month)}/1#event-{event_id}"
        return result
    if command == "upload-image":
        return client.upload(args.id, args.file)
    if command == "delete-image":
        return client.request("DELETE", f"/api/events/{args.id}/images/{args.image_id}")
    if command == "download-image":
        data = client.request("GET", f"/api/events/{args.id}/images/{args.image_id}", binary=True)
        # Exclusive creation prevents accidental overwrite of an existing local file.
        with args.output.open("xb") as file:
            file.write(data)
        return {"saved": args.output.name, "bytes": len(data)}
    if command == "delete":
        return client.request("DELETE", f"/api/events/{args.id}")


def parser():
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("--database", type=Path, default=Path("/srv/data/pp-calendar/calendar.sqlite"))
    result.add_argument("--base-url", default="http://127.0.0.1:8771")
    result.add_argument("--in-service-network", action="store_true", help=argparse.SUPPRESS)
    sub = result.add_subparsers(dest="command", required=True)
    sub.add_parser("calendars")
    listing = sub.add_parser("events")
    listing.add_argument("--start", required=True)
    listing.add_argument("--end", required=True)
    listing.add_argument("--query")
    for name in ("get", "create", "update", "delete", "upload-image", "delete-image", "download-image"):
        child = sub.add_parser(name)
        if name != "create":
            child.add_argument("--id", type=int, required=True)
        if name in ("create", "update"):
            child.add_argument("--payload-file", type=Path, required=True)
            child.add_argument("--image", type=Path, action="append", default=[])
        if name == "create":
            child.add_argument("--request-id", required=True)
        if name == "upload-image":
            child.add_argument("--file", type=Path, required=True)
        if name in ("delete-image", "download-image"):
            child.add_argument("--image-id", type=int, required=True)
        if name == "download-image":
            child.add_argument("--output", type=Path, required=True)
    return result


def main():
    args = parser().parse_args()
    if os.geteuid() != 0:
        raise SystemExit("此工具仅限 PPHK 宿主管理任务；普通租户需使用其获授权的连接。")
    base = urlparse(args.base_url)
    if base.scheme != "http" or base.hostname != "127.0.0.1" or base.username or base.password or base.path not in ("", "/"):
        raise SystemExit("仅允许本机回环 Calendar API")
    if not args.in_service_network and args.base_url == "http://127.0.0.1:8771":
        pid = subprocess.check_output(["systemctl", "show", "pp-calendar.service", "-p", "MainPID", "--value"], text=True).strip()
        if not pid.isdecimal() or pid == "0":
            raise SystemExit("Calendar 服务未运行")
        if os.stat(f"/proc/{pid}/ns/net").st_ino != os.stat("/proc/self/ns/net").st_ino:
            os.execvp("nsenter", ["nsenter", "-t", pid, "-n", sys.executable, "-m", "app.agent_cli", "--in-service-network", *sys.argv[1:]])
    try:
        with local_session(args.database) as (token, csrf):
            result = perform(CalendarClient(args.base_url, token, csrf), args)
        print(json.dumps(result, ensure_ascii=False))
        if result.get("complete") is False:
            raise SystemExit(2)
    except (OSError, ValueError, RuntimeError, sqlite3.Error) as error:
        print(json.dumps({"error": str(error)}, ensure_ascii=False))
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
