import importlib
import os

from fastapi.testclient import TestClient

os.environ.setdefault("PP_CALENDAR_PASSWORD_HASH", "placeholder")
main = importlib.import_module("app.main")


def make_client(tmp_path):
    main.DB_PATH = tmp_path / "calendar.sqlite"
    main.PASSWORD_HASH = main.hash_password("correct-horse")
    main.login_attempts.clear()
    return TestClient(main.app, base_url="https://calendar.test")


def login(client):
    response = client.post("/api/login", json={"username": "PP", "password": "correct-horse"})
    assert response.status_code == 200
    return response.json()["csrf_token"]


def test_authentication_and_security_headers(tmp_path):
    with make_client(tmp_path) as client:
        month_page = client.get("/month/2023/5/1")
        assert month_page.status_code == 200
        assert "PP Calendar" in month_page.text
        assert client.get("/month/2023/13/1").status_code == 404
        assert client.get("/api/session").json() == {"authenticated": False}
        denied = client.post("/api/login", json={"username": "PP", "password": "wrong"})
        assert denied.status_code == 401
        csrf = login(client)
        session = client.get("/api/session")
        assert session.json()["authenticated"] is True
        assert session.json()["csrf_token"] == csrf
        assert session.headers["x-frame-options"] == "DENY"
        assert "frame-ancestors 'none'" in session.headers["content-security-policy"]


def test_calendar_and_event_crud_search(tmp_path):
    with make_client(tmp_path) as client:
        csrf = login(client)
        headers = {"X-CSRF-Token": csrf}
        calendars = client.get("/api/calendars").json()["calendars"]
        assert [item["name"] for item in calendars] == ["工作日志", "生活日志", "周期事件", "好事发生"]

        created_calendar = client.post(
            "/api/calendars", headers=headers, json={"name": "学习", "color": "#227755"}
        )
        assert created_calendar.status_code == 201
        calendar_id = created_calendar.json()["calendar"]["id"]

        created_event = client.post(
            "/api/events", headers=headers,
            json={"title": "学习 FastAPI", "event_date": "2026-08-03", "calendar_id": calendar_id, "notes": "搜索测试关键词"},
        )
        assert created_event.status_code == 201
        event_id = created_event.json()["event"]["id"]

        ranged = client.get("/api/events?start=2026-08-01&end=2026-08-31").json()["events"]
        assert [item["id"] for item in ranged] == [event_id]
        assert client.get("/api/events?q=关键词").json()["events"][0]["title"] == "学习 FastAPI"

        updated = client.patch(
            f"/api/events/{event_id}", headers=headers,
            json={"title": "复习 FastAPI", "event_date": "2026-08-04"},
        )
        assert updated.status_code == 200
        assert updated.json()["event"]["event_date"] == "2026-08-04"

        cannot_delete = client.delete(f"/api/calendars/{calendar_id}", headers=headers)
        assert cannot_delete.status_code == 409
        assert client.delete(f"/api/events/{event_id}", headers=headers).status_code == 200
        assert client.delete(f"/api/calendars/{calendar_id}", headers=headers).status_code == 200


def test_csrf_validation_and_input_boundaries(tmp_path):
    with make_client(tmp_path) as client:
        csrf = login(client)
        calendar_id = client.get("/api/calendars").json()["calendars"][0]["id"]
        no_csrf = client.post(
            "/api/events", json={"title": "A", "event_date": "2026-08-03", "calendar_id": calendar_id}
        )
        assert no_csrf.status_code == 403
        bad_date = client.post(
            "/api/events", headers={"X-CSRF-Token": csrf},
            json={"title": "A", "event_date": "2026-02-30", "calendar_id": calendar_id},
        )
        assert bad_date.status_code == 422
        bad_color = client.post(
            "/api/calendars", headers={"X-CSRF-Token": csrf}, json={"name": "坏颜色", "color": "red"}
        )
        assert bad_color.status_code == 422


def test_logout_invalidates_session(tmp_path):
    with make_client(tmp_path) as client:
        csrf = login(client)
        response = client.post("/api/logout", headers={"X-CSRF-Token": csrf})
        assert response.status_code == 200
        assert client.get("/api/calendars").status_code == 401
