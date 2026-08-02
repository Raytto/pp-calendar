from __future__ import annotations

import hashlib
import hmac
import os
import re
import secrets
import sqlite3
import threading
import time
from collections import defaultdict, deque
from contextlib import asynccontextmanager, contextmanager
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Annotated, Iterator

from fastapi import Cookie, Depends, FastAPI, Header, HTTPException, Query, Request, Response
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field, field_validator

APP_ROOT = Path(__file__).resolve().parent
STATIC_ROOT = APP_ROOT / "static"
DB_PATH = Path(os.getenv("PP_CALENDAR_DB", "/srv/data/pp-calendar/calendar.sqlite"))
USERNAME = os.getenv("PP_CALENDAR_USERNAME", "PP")
PASSWORD_HASH = os.getenv("PP_CALENDAR_PASSWORD_HASH", "")
COOKIE_NAME = "pp_calendar_session"
SESSION_DAYS = 30
COLOR_RE = re.compile(r"^#[0-9a-fA-F]{6}$")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
write_lock = threading.RLock()
login_attempts: dict[str, deque[float]] = defaultdict(deque)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def hash_password(password: str, salt: bytes | None = None, rounds: int = 310_000) -> str:
    salt = salt or secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, rounds)
    return f"pbkdf2_sha256${rounds}${salt.hex()}${digest.hex()}"


def verify_password(password: str, encoded: str) -> bool:
    try:
        algorithm, rounds_text, salt_hex, expected_hex = encoded.split("$", 3)
        if algorithm != "pbkdf2_sha256":
            return False
        candidate = hashlib.pbkdf2_hmac(
            "sha256", password.encode("utf-8"), bytes.fromhex(salt_hex), int(rounds_text)
        )
        return hmac.compare_digest(candidate, bytes.fromhex(expected_hex))
    except (ValueError, TypeError):
        return False


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


@contextmanager
def db() -> Iterator[sqlite3.Connection]:
    connection = sqlite3.connect(DB_PATH, timeout=10)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys=ON")
    connection.execute("PRAGMA busy_timeout=10000")
    try:
        yield connection
    finally:
        connection.close()


def initialize_database() -> None:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with write_lock, db() as connection:
        connection.executescript(
            """
            PRAGMA journal_mode=WAL;
            PRAGMA synchronous=NORMAL;
            CREATE TABLE IF NOT EXISTS calendars (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL UNIQUE COLLATE NOCASE,
                color TEXT NOT NULL,
                sort_order INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                event_date TEXT NOT NULL,
                calendar_id INTEGER NOT NULL REFERENCES calendars(id) ON DELETE RESTRICT,
                notes TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS events_date_idx ON events(event_date, id);
            CREATE INDEX IF NOT EXISTS events_calendar_idx ON events(calendar_id, event_date);
            CREATE TABLE IF NOT EXISTS sessions (
                token_hash TEXT PRIMARY KEY,
                csrf_token TEXT NOT NULL,
                expires_at INTEGER NOT NULL,
                created_at TEXT NOT NULL
            );
            """
        )
        existing = connection.execute("SELECT COUNT(*) AS total FROM calendars").fetchone()["total"]
        if existing == 0:
            created = now_iso()
            defaults = [
                ("工作日志", "#A62B5B", 0),
                ("生活日志", "#4856B7", 1),
                ("周期事件", "#8A3CB2", 2),
                ("好事发生", "#E07A18", 3),
            ]
            connection.executemany(
                "INSERT INTO calendars(name,color,sort_order,created_at,updated_at) VALUES(?,?,?,?,?)",
                [(name, color, order, created, created) for name, color, order in defaults],
            )
        connection.execute("DELETE FROM sessions WHERE expires_at < ?", (int(time.time()),))
        connection.commit()


class LoginInput(BaseModel):
    username: str = Field(min_length=1, max_length=80)
    password: str = Field(min_length=1, max_length=256)


class CalendarInput(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)
    name: str = Field(min_length=1, max_length=60)
    color: str

    @field_validator("color")
    @classmethod
    def valid_color(cls, value: str) -> str:
        if not COLOR_RE.fullmatch(value):
            raise ValueError("颜色格式无效")
        return value.upper()


class CalendarUpdate(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)
    name: str | None = Field(default=None, min_length=1, max_length=60)
    color: str | None = None

    @field_validator("color")
    @classmethod
    def valid_color(cls, value: str | None) -> str | None:
        if value is not None and not COLOR_RE.fullmatch(value):
            raise ValueError("颜色格式无效")
        return value.upper() if value else value


class EventInput(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)
    title: str = Field(min_length=1, max_length=200)
    event_date: str
    calendar_id: int = Field(gt=0)
    notes: str = Field(default="", max_length=10_000)

    @field_validator("event_date")
    @classmethod
    def valid_date(cls, value: str) -> str:
        if not DATE_RE.fullmatch(value):
            raise ValueError("日期格式无效")
        try:
            date.fromisoformat(value)
        except ValueError as error:
            raise ValueError("日期无效") from error
        return value


class EventUpdate(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)
    title: str | None = Field(default=None, min_length=1, max_length=200)
    event_date: str | None = None
    calendar_id: int | None = Field(default=None, gt=0)
    notes: str | None = Field(default=None, max_length=10_000)

    @field_validator("event_date")
    @classmethod
    def valid_date(cls, value: str | None) -> str | None:
        if value is None:
            return value
        if not DATE_RE.fullmatch(value):
            raise ValueError("日期格式无效")
        try:
            date.fromisoformat(value)
        except ValueError as error:
            raise ValueError("日期无效") from error
        return value


@asynccontextmanager
async def lifespan(_app: FastAPI):
    if not PASSWORD_HASH:
        raise RuntimeError("PP_CALENDAR_PASSWORD_HASH is required")
    initialize_database()
    yield


app = FastAPI(title="PP Calendar", docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)
app.mount("/static", StaticFiles(directory=STATIC_ROOT), name="static")


@app.middleware("http")
async def security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "same-origin"
    response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; "
        "font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"
    )
    if request.url.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store"
    return response


def current_session(session_token: Annotated[str | None, Cookie(alias=COOKIE_NAME)] = None) -> sqlite3.Row:
    if not session_token:
        raise HTTPException(401, "请先登录")
    with db() as connection:
        row = connection.execute(
            "SELECT * FROM sessions WHERE token_hash=? AND expires_at>=?",
            (token_hash(session_token), int(time.time())),
        ).fetchone()
    if not row:
        raise HTTPException(401, "登录已过期")
    return row


def csrf_session(
    request: Request,
    session: Annotated[sqlite3.Row, Depends(current_session)],
    csrf: Annotated[str | None, Header(alias="X-CSRF-Token")] = None,
) -> sqlite3.Row:
    if not csrf or not hmac.compare_digest(csrf, session["csrf_token"]):
        raise HTTPException(403, "安全校验失败")
    origin = request.headers.get("origin")
    if origin:
        forwarded_host = request.headers.get("x-forwarded-host", request.headers.get("host", "")).split(",")[0].strip()
        try:
            if origin.split("//", 1)[-1].split("/", 1)[0] != forwarded_host:
                raise HTTPException(403, "请求来源不受信任")
        except (ValueError, IndexError):
            raise HTTPException(403, "请求来源不受信任")
    return session


def event_view(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "title": row["title"],
        "event_date": row["event_date"],
        "calendar_id": row["calendar_id"],
        "calendar_name": row["calendar_name"],
        "calendar_color": row["calendar_color"],
        "notes": row["notes"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


EVENT_JOIN = """
SELECT e.*, c.name AS calendar_name, c.color AS calendar_color
FROM events e JOIN calendars c ON c.id=e.calendar_id
"""


@app.get("/")
def index() -> FileResponse:
    return FileResponse(STATIC_ROOT / "index.html", headers={"Cache-Control": "no-cache"})


@app.get("/month/{year}/{month}/{day}")
def month_view(year: int, month: int, day: int) -> FileResponse:
    try:
        date(year, month, day)
    except ValueError as error:
        raise HTTPException(404, "日期路径无效") from error
    return index()


@app.get("/health")
def health() -> dict:
    with db() as connection:
        connection.execute("SELECT 1").fetchone()
    return {"status": "ok"}


@app.get("/api/session")
def session_info(session_token: Annotated[str | None, Cookie(alias=COOKIE_NAME)] = None) -> dict:
    if not session_token:
        return {"authenticated": False}
    try:
        session = current_session(session_token)
    except HTTPException:
        return {"authenticated": False}
    return {"authenticated": True, "username": USERNAME, "csrf_token": session["csrf_token"]}


@app.post("/api/login")
def login(payload: LoginInput, request: Request, response: Response) -> dict:
    client = request.headers.get("x-real-ip") or (request.client.host if request.client else "unknown")
    attempts = login_attempts[client]
    current = time.time()
    while attempts and attempts[0] < current - 600:
        attempts.popleft()
    if len(attempts) >= 10:
        raise HTTPException(429, "尝试次数过多，请稍后再试")
    if payload.username.casefold() != USERNAME.casefold() or not verify_password(payload.password, PASSWORD_HASH):
        attempts.append(current)
        raise HTTPException(401, "用户名或密码错误")
    attempts.clear()
    raw_token = secrets.token_urlsafe(40)
    csrf = secrets.token_urlsafe(32)
    expires = int(time.time() + SESSION_DAYS * 86400)
    with write_lock, db() as connection:
        connection.execute("DELETE FROM sessions WHERE expires_at < ?", (int(time.time()),))
        connection.execute(
            "INSERT INTO sessions(token_hash,csrf_token,expires_at,created_at) VALUES(?,?,?,?)",
            (token_hash(raw_token), csrf, expires, now_iso()),
        )
        connection.commit()
    response.set_cookie(
        COOKIE_NAME, raw_token, max_age=SESSION_DAYS * 86400, secure=True,
        httponly=True, samesite="strict", path="/",
    )
    return {"authenticated": True, "username": USERNAME, "csrf_token": csrf}


@app.post("/api/logout")
def logout(
    response: Response,
    session_token: Annotated[str | None, Cookie(alias=COOKIE_NAME)] = None,
    _session: Annotated[sqlite3.Row, Depends(csrf_session)] = None,
) -> dict:
    if session_token:
        with write_lock, db() as connection:
            connection.execute("DELETE FROM sessions WHERE token_hash=?", (token_hash(session_token),))
            connection.commit()
    response.delete_cookie(COOKIE_NAME, path="/")
    return {"ok": True}


@app.get("/api/calendars")
def list_calendars(_session: Annotated[sqlite3.Row, Depends(current_session)]) -> dict:
    with db() as connection:
        rows = connection.execute(
            "SELECT c.*, (SELECT COUNT(*) FROM events e WHERE e.calendar_id=c.id) AS event_count "
            "FROM calendars c ORDER BY sort_order,id"
        ).fetchall()
    return {"calendars": [dict(row) for row in rows]}


@app.post("/api/calendars", status_code=201)
def create_calendar(payload: CalendarInput, _session: Annotated[sqlite3.Row, Depends(csrf_session)]) -> dict:
    created = now_iso()
    try:
        with write_lock, db() as connection:
            order = connection.execute("SELECT COALESCE(MAX(sort_order),-1)+1 AS value FROM calendars").fetchone()["value"]
            cursor = connection.execute(
                "INSERT INTO calendars(name,color,sort_order,created_at,updated_at) VALUES(?,?,?,?,?)",
                (payload.name, payload.color, order, created, created),
            )
            connection.commit()
            row = connection.execute("SELECT *,0 AS event_count FROM calendars WHERE id=?", (cursor.lastrowid,)).fetchone()
    except sqlite3.IntegrityError:
        raise HTTPException(409, "日历名称已存在")
    return {"calendar": dict(row)}


@app.patch("/api/calendars/{calendar_id}")
def update_calendar(calendar_id: int, payload: CalendarUpdate, _session: Annotated[sqlite3.Row, Depends(csrf_session)]) -> dict:
    values = payload.model_dump(exclude_none=True)
    if not values:
        raise HTTPException(400, "没有需要修改的内容")
    assignments = ",".join(f"{key}=?" for key in values)
    try:
        with write_lock, db() as connection:
            cursor = connection.execute(
                f"UPDATE calendars SET {assignments},updated_at=? WHERE id=?",
                (*values.values(), now_iso(), calendar_id),
            )
            if cursor.rowcount == 0:
                raise HTTPException(404, "日历不存在")
            connection.commit()
            row = connection.execute(
                "SELECT c.*, (SELECT COUNT(*) FROM events e WHERE e.calendar_id=c.id) AS event_count FROM calendars c WHERE id=?",
                (calendar_id,),
            ).fetchone()
    except sqlite3.IntegrityError:
        raise HTTPException(409, "日历名称已存在")
    return {"calendar": dict(row)}


@app.delete("/api/calendars/{calendar_id}")
def delete_calendar(calendar_id: int, _session: Annotated[sqlite3.Row, Depends(csrf_session)]) -> dict:
    with write_lock, db() as connection:
        count = connection.execute("SELECT COUNT(*) AS total FROM events WHERE calendar_id=?", (calendar_id,)).fetchone()["total"]
        if count:
            raise HTTPException(409, "该日历中仍有事件，请先移动或删除事件")
        if connection.execute("SELECT COUNT(*) AS total FROM calendars").fetchone()["total"] <= 1:
            raise HTTPException(409, "至少保留一个日历")
        cursor = connection.execute("DELETE FROM calendars WHERE id=?", (calendar_id,))
        if cursor.rowcount == 0:
            raise HTTPException(404, "日历不存在")
        connection.commit()
    return {"ok": True}


@app.get("/api/events")
def list_events(
    _session: Annotated[sqlite3.Row, Depends(current_session)],
    start: str | None = None,
    end: str | None = None,
    q: str | None = None,
    page: Annotated[int, Query(ge=1)] = 1,
    page_size: Annotated[int, Query(ge=1, le=100)] = 100,
) -> dict:
    clauses: list[str] = []
    values: list[object] = []
    if start:
        if not DATE_RE.fullmatch(start):
            raise HTTPException(400, "开始日期格式无效")
        clauses.append("e.event_date>=?")
        values.append(start)
    if end:
        if not DATE_RE.fullmatch(end):
            raise HTTPException(400, "结束日期格式无效")
        clauses.append("e.event_date<=?")
        values.append(end)
    query = (q or "").strip()
    if query:
        clauses.append("(e.title LIKE ? ESCAPE '\\' OR e.notes LIKE ? ESCAPE '\\' OR c.name LIKE ? ESCAPE '\\')")
        escaped = query.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        values.extend([f"%{escaped}%"] * 3)
    where = f" WHERE {' AND '.join(clauses)}" if clauses else ""
    with db() as connection:
        if query:
            total = connection.execute(
                "SELECT COUNT(*) AS total FROM events e JOIN calendars c ON c.id=e.calendar_id" + where,
                values,
            ).fetchone()["total"]
            rows = connection.execute(
                EVENT_JOIN + where + " ORDER BY e.event_date DESC,e.id DESC LIMIT ? OFFSET ?",
                (*values, page_size, (page - 1) * page_size),
            ).fetchall()
            total_pages = (total + page_size - 1) // page_size
            pagination = {
                "page": page,
                "page_size": page_size,
                "total": total,
                "total_pages": total_pages,
                "has_previous": page > 1,
                "has_next": page < total_pages,
            }
        else:
            rows = connection.execute(
                EVENT_JOIN + where + " ORDER BY e.event_date DESC,e.id DESC LIMIT 2000", values
            ).fetchall()
            pagination = None
    return {"events": [event_view(row) for row in rows], "query": query, "pagination": pagination}


@app.get("/api/events/{event_id}")
def get_event(event_id: int, _session: Annotated[sqlite3.Row, Depends(current_session)]) -> dict:
    with db() as connection:
        row = connection.execute(EVENT_JOIN + " WHERE e.id=?", (event_id,)).fetchone()
    if not row:
        raise HTTPException(404, "事件不存在")
    return {"event": event_view(row)}


def ensure_calendar(connection: sqlite3.Connection, calendar_id: int) -> None:
    if not connection.execute("SELECT 1 FROM calendars WHERE id=?", (calendar_id,)).fetchone():
        raise HTTPException(400, "所属日历不存在")


@app.post("/api/events", status_code=201)
def create_event(payload: EventInput, _session: Annotated[sqlite3.Row, Depends(csrf_session)]) -> dict:
    created = now_iso()
    with write_lock, db() as connection:
        ensure_calendar(connection, payload.calendar_id)
        cursor = connection.execute(
            "INSERT INTO events(title,event_date,calendar_id,notes,created_at,updated_at) VALUES(?,?,?,?,?,?)",
            (payload.title, payload.event_date, payload.calendar_id, payload.notes, created, created),
        )
        connection.commit()
        row = connection.execute(EVENT_JOIN + " WHERE e.id=?", (cursor.lastrowid,)).fetchone()
    return {"event": event_view(row)}


@app.patch("/api/events/{event_id}")
def update_event(event_id: int, payload: EventUpdate, _session: Annotated[sqlite3.Row, Depends(csrf_session)]) -> dict:
    values = payload.model_dump(exclude_none=True)
    if not values:
        raise HTTPException(400, "没有需要修改的内容")
    with write_lock, db() as connection:
        if "calendar_id" in values:
            ensure_calendar(connection, values["calendar_id"])
        assignments = ",".join(f"{key}=?" for key in values)
        cursor = connection.execute(
            f"UPDATE events SET {assignments},updated_at=? WHERE id=?",
            (*values.values(), now_iso(), event_id),
        )
        if cursor.rowcount == 0:
            raise HTTPException(404, "事件不存在")
        connection.commit()
        row = connection.execute(EVENT_JOIN + " WHERE e.id=?", (event_id,)).fetchone()
    return {"event": event_view(row)}


@app.delete("/api/events/{event_id}")
def delete_event(event_id: int, _session: Annotated[sqlite3.Row, Depends(csrf_session)]) -> dict:
    with write_lock, db() as connection:
        cursor = connection.execute("DELETE FROM events WHERE id=?", (event_id,))
        if cursor.rowcount == 0:
            raise HTTPException(404, "事件不存在")
        connection.commit()
    return {"ok": True}


@app.exception_handler(HTTPException)
async def http_error(_request: Request, exc: HTTPException) -> JSONResponse:
    return JSONResponse({"error": exc.detail}, status_code=exc.status_code)


if __name__ == "__main__":
    import sys

    if len(sys.argv) == 3 and sys.argv[1] == "hash-password":
        print(hash_password(sys.argv[2]))
    else:
        raise SystemExit("usage: python -m app.main hash-password <password>")
