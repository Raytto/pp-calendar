from io import BytesIO
import sqlite3

from PIL import Image

from app import images
from deploy.backup import create_daily_snapshot
from test_app import make_client, login, main


def encoded(color="red", size=(900, 600), format="JPEG", **kwargs):
    target = BytesIO()
    Image.new("RGB", size, color).save(target, format=format, **kwargs)
    return target.getvalue()


def event(client, headers):
    calendar_id = client.get("/api/calendars").json()["calendars"][0]["id"]
    return client.post("/api/events", headers=headers, json={
        "title": "图片测试", "event_date": "2026-09-10", "calendar_id": calendar_id,
        "notes": "热量估算：650 kcal；范围 520–820 kcal",
    }).json()["event"]["id"]


def test_image_lifecycle_authentication_replay_and_cascade(tmp_path):
    with make_client(tmp_path) as client:
        headers = {"X-CSRF-Token": login(client)}
        event_id = event(client, headers)
        base = f"/api/events/{event_id}/images"
        assert client.post(base, content=encoded()).status_code == 403
        created = client.post(base, params={"name": "午餐.jpg"}, headers=headers, content=encoded())
        assert created.status_code == 201
        item = created.json()["image"]
        replay = client.post(base, headers=headers, content=encoded()).json()
        assert replay["replayed"] and replay["image"]["id"] == item["id"]
        listing = client.get(base).json()["images"]
        assert len(listing) == 1 and listing[0]["name"] == "午餐.jpg"
        assert "image" not in listing[0]  # Month and metadata payloads never carry blobs.
        full = client.get(item["url"])
        small = client.get(item["thumbnail_url"])
        assert full.headers["content-type"] == "image/webp"
        assert full.headers["cache-control"] == "private, no-store"
        assert Image.open(BytesIO(full.content)).size == (900, 600)
        assert max(Image.open(BytesIO(small.content)).size) == 320
        other = event(client, headers)
        assert client.get(f"/api/events/{other}/images/{item['id']}").status_code == 404
        client.delete(f"/api/events/{other}/images/{item['id']}", headers=headers)
        assert client.get(item["url"]).status_code == 200
        client.post("/api/logout", headers=headers)
        assert client.get(item["url"]).status_code == 401
        assert client.get(item["thumbnail_url"]).status_code == 401
        assert client.get(base).status_code == 401
        headers = {"X-CSRF-Token": login(client)}
        assert client.delete(item["url"], headers=headers).status_code == 200
        assert client.delete(item["url"], headers=headers).status_code == 200
        assert client.get(item["url"]).status_code == 404
        second = client.post(base, headers=headers, content=encoded()).json()["image"]
        client.delete(f"/api/events/{event_id}", headers=headers)
        assert client.get(second["url"]).status_code == 404
        with main.db() as connection:
            assert connection.execute("SELECT COUNT(*) FROM event_images").fetchone()[0] == 0
            assert connection.execute("PRAGMA foreign_key_check").fetchall() == []


def test_image_validation_and_event_limit(tmp_path, monkeypatch):
    with make_client(tmp_path) as client:
        headers = {"X-CSRF-Token": login(client)}
        event_id = event(client, headers)
        base = f"/api/events/{event_id}/images"
        for invalid in (b"<svg onload='evil()'></svg>", b"not a jpg", encoded()[:40]):
            assert client.post(base, headers=headers, content=invalid).status_code == 415
        assert client.post(base, headers=headers, content=b"").status_code == 413
        assert client.post(base, headers={**headers, "Content-Length": str(images.MAX_UPLOAD_BYTES + 1)}, content=b"x").status_code == 413
        monkeypatch.setattr(images, "MAX_PIXELS", 100)
        assert client.post(base, headers=headers, content=encoded(size=(11, 11))).status_code == 413
        monkeypatch.setattr(images, "MAX_PIXELS", 50_000_000)
        monkeypatch.setattr(main, "MAX_EVENT_IMAGES", 2)
        for color in ("red", "blue"):
            assert client.post(base, headers=headers, content=encoded(color)).status_code == 201
        assert client.post(base, headers=headers, content=encoded("green")).status_code == 409
        assert client.post(base, headers=headers, content=encoded("red")).json()["replayed"]
        assert client.post("/api/events/999999/images", headers=headers, content=encoded()).status_code == 404


def test_orientation_resize_metadata_and_heic():
    exif = Image.Exif()
    exif[274] = 6
    exif[315] = "private author"
    prepared = images.prepare_image(encoded(size=(3000, 1500), exif=exif))
    assert (prepared.width, prepared.height) == (1280, 2560)
    decoded = Image.open(BytesIO(prepared.image))
    assert not decoded.getexif()
    assert "exif" not in decoded.info
    heic = encoded(size=(400, 300), format="HEIF")
    converted = images.prepare_image(heic)
    assert Image.open(BytesIO(converted.image)).size == (400, 300)


def test_existing_backup_restores_image_bytes_and_notes(tmp_path):
    with make_client(tmp_path) as client:
        headers = {"X-CSRF-Token": login(client)}
        event_id = event(client, headers)
        item = client.post(f"/api/events/{event_id}/images", headers=headers, content=encoded()).json()["image"]
        original = client.get(item["url"]).content
        thumbnail = client.get(item["thumbnail_url"]).content
        snapshot = tmp_path / "restore.sqlite"
        create_daily_snapshot(main.DB_PATH, snapshot)
        client.delete(f"/api/events/{event_id}", headers=headers)
        main.DB_PATH = snapshot
        assert client.get(item["url"]).content == original
        assert client.get(item["thumbnail_url"]).content == thumbnail
        assert "650 kcal" in client.get(f"/api/events/{event_id}").json()["event"]["notes"]
        with sqlite3.connect(snapshot) as connection:
            assert connection.execute("PRAGMA integrity_check").fetchone()[0] == "ok"


def test_schema_upgrade_preserves_existing_events(tmp_path):
    with make_client(tmp_path) as client:
        headers = {"X-CSRF-Token": login(client)}
        event_id = event(client, headers)
        with main.db() as connection:
            connection.execute("DROP TABLE event_images")
            connection.commit()
        main.initialize_database()
        assert client.get(f"/api/events/{event_id}").json()["event"]["title"] == "图片测试"
        assert client.get(f"/api/events/{event_id}/images").json()["images"] == []
