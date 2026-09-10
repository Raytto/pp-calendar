from argparse import Namespace
import json
from pathlib import Path

import pytest

from app.agent_cli import CalendarClient, local_session, perform
from test_app import make_client, main
from test_images import encoded


class Adapter(CalendarClient):
    def __init__(self, client, token, csrf):
        self.client, self.token, self.csrf = client, token, csrf

    def request(self, method, path, payload=None, *, content=None, key=None, binary=False):
        headers = {"Cookie": f"pp_calendar_session={self.token}", "X-CSRF-Token": self.csrf}
        if key:
            headers["Idempotency-Key"] = key
        response = self.client.request(method, path, json=payload, content=content, headers=headers)
        if response.status_code >= 400:
            raise RuntimeError(response.json()["error"])
        return response.content if binary else response.json()


def test_agent_create_retry_and_partial_attachment_failure(tmp_path):
    with make_client(tmp_path) as http:
        with local_session(main.DB_PATH) as (token, csrf):
            client = Adapter(http, token, csrf)
            calendar_id = client.request("GET", "/api/calendars")["calendars"][0]["id"]
            payload = tmp_path / "event.json"
            payload.write_text(json.dumps({"title": "午餐", "event_date": "2026-09-10", "calendar_id": calendar_id, "notes": "热量未知"}))
            photo = tmp_path / "image.jpg"
            photo.write_bytes(encoded())
            args = Namespace(command="create", payload_file=payload, request_id="image-agent-retry-request", image=[photo, tmp_path / "missing.jpg"])
            partial = perform(client, args)
            assert not partial["complete"] and len(partial["images"]) == 1
            assert partial["image_errors"][0]["file"] == "missing.jpg"
            args.image = [photo]
            replay = perform(client, args)
            assert replay["complete"]
            assert replay["event"]["id"] == partial["event"]["id"]
            assert len(replay["images"]) == 1
            assert replay["url"].endswith(f"#event-{replay['event']['id']}")
        with main.db() as connection:
            assert connection.execute("SELECT COUNT(*) FROM sessions").fetchone()[0] == 0


def test_temporary_session_revoked_on_exception(tmp_path):
    with make_client(tmp_path):
        with pytest.raises(RuntimeError):
            with local_session(main.DB_PATH):
                raise RuntimeError("interrupted operation")
        with main.db() as connection:
            assert connection.execute("SELECT COUNT(*) FROM sessions").fetchone()[0] == 0
