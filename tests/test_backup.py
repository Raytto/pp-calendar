import sqlite3
from datetime import datetime

from deploy.backup import (
    BackupConfig,
    DAILY_PATTERN,
    MONTHLY_PATTERN,
    WEEKLY_PATTERN,
    remote_weekly_names,
    run_backup,
    sync_cloud_weeklies,
    tier_files,
)


def create_source(path):
    with sqlite3.connect(path) as connection:
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("CREATE TABLE records(id INTEGER PRIMARY KEY, value TEXT NOT NULL)")
        connection.execute("INSERT INTO records(value) VALUES('initial')")
        connection.commit()


def test_gfs_rotation_and_same_day_idempotence(tmp_path):
    source = tmp_path / "calendar.sqlite"
    target = tmp_path / "backups"
    create_source(source)
    config = BackupConfig(source=source, target_root=target, sync_cloud=False)

    dates = [datetime(2026, month, 1, 3, 26) for month in range(1, 9)]
    for index, current in enumerate(dates):
        with sqlite3.connect(source) as connection:
            connection.execute("INSERT INTO records(value) VALUES(?)", (f"month-{index}",))
            connection.commit()
        run_backup(config, current)

    daily = tier_files(target / "auto" / "daily", DAILY_PATTERN)
    weekly = tier_files(target / "auto" / "weekly", WEEKLY_PATTERN)
    monthly = tier_files(target / "auto" / "monthly", MONTHLY_PATTERN)
    assert len(daily) == 5
    assert len(weekly) == 4
    assert len(monthly) == 6
    assert daily[-1].name == "pp-calendar-daily-2026-08-01.sqlite"
    assert monthly[0].name == "pp-calendar-monthly-2026-03.sqlite"

    repeated = run_backup(config, dates[-1])
    assert repeated.daily_created is False
    assert repeated.weekly_created is False
    assert repeated.monthly_created is False
    assert len(tier_files(target / "auto" / "daily", DAILY_PATTERN)) == 5
    assert not list((target / "auto" / "daily").glob(".*.tmp-*"))


def test_rotation_does_not_touch_manual_or_legacy_snapshots(tmp_path):
    source = tmp_path / "calendar.sqlite"
    target = tmp_path / "backups"
    create_source(source)
    config = BackupConfig(source=source, target_root=target, sync_cloud=False)
    run_backup(config, datetime(2026, 8, 3, 3, 26))

    manual = target / "manual" / "calendar-pre-change.sqlite"
    legacy = target / "legacy" / "calendar-20260803-032817.sqlite"
    manual.write_bytes(b"manual")
    legacy.write_bytes(b"legacy")

    for day in range(4, 11):
        run_backup(config, datetime(2026, 8, day, 3, 26))

    assert manual.read_bytes() == b"manual"
    assert legacy.read_bytes() == b"legacy"


def test_existing_remote_weekly_is_not_uploaded_again(tmp_path, monkeypatch):
    source = tmp_path / "calendar.sqlite"
    target = tmp_path / "backups"
    create_source(source)
    config = BackupConfig(source=source, target_root=target, sync_cloud=False)
    result = run_backup(config, datetime(2026, 8, 3, 3, 26))
    state = target / "auto" / ".state"

    monkeypatch.setattr(
        "deploy.backup.remote_weekly_names", lambda _config: [result.weekly.name]
    )
    monkeypatch.setattr(
        "deploy.backup.upload_weekly",
        lambda _config, _weekly: (_ for _ in ()).throw(AssertionError("unexpected upload")),
    )

    sync_cloud_weeklies(config, target / "auto" / "weekly", state)
    assert (state / f"{result.weekly.name}.sha256").exists()


def test_remote_listing_only_accepts_strict_weekly_names(monkeypatch):
    output = """
    pp-calendar-weekly-2026-W31.sqlite -> /backup/pp-calendar/pp-calendar-weekly-2026-W31.sqlite
    pp-calendar-weekly-2026-W32(1).sqlite -> /backup/pp-calendar/pp-calendar-weekly-2026-W32(1).sqlite
    unrelated.sqlite -> /backup/pp-calendar/unrelated.sqlite
    """
    monkeypatch.setattr("deploy.backup.run_aliyunpan", lambda _config, *_args: output)
    assert remote_weekly_names(BackupConfig()) == ["pp-calendar-weekly-2026-W31.sqlite"]


def test_cloud_rotation_removes_only_expired_strict_weekly(tmp_path, monkeypatch):
    source = tmp_path / "calendar.sqlite"
    target = tmp_path / "backups"
    create_source(source)
    config = BackupConfig(source=source, target_root=target, sync_cloud=False)
    for day in (6, 13, 20, 27):
        run_backup(config, datetime(2026, 7, day, 3, 26))
    run_backup(config, datetime(2026, 8, 3, 3, 26))

    remote = [f"pp-calendar-weekly-2026-W{week:02d}.sqlite" for week in range(28, 33)]
    monkeypatch.setattr("deploy.backup.remote_weekly_names", lambda _config: remote)
    calls = []
    monkeypatch.setattr(
        "deploy.backup.run_aliyunpan",
        lambda _config, *arguments: calls.append(arguments) or "",
    )

    sync_cloud_weeklies(config, target / "auto" / "weekly", target / "auto" / ".state")
    assert calls == [("rm", "/backup/pp-calendar/pp-calendar-weekly-2026-W28.sqlite")]
