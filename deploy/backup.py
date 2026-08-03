#!/usr/bin/env python3
"""Create and rotate PP Calendar GFS backups, including weekly AliyunPan copies."""

from __future__ import annotations

import grp
import hashlib
import os
import pwd
import re
import shutil
import sqlite3
import subprocess
import tempfile
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path


DAILY_PATTERN = re.compile(r"pp-calendar-daily-\d{4}-\d{2}-\d{2}\.sqlite")
WEEKLY_PATTERN = re.compile(r"pp-calendar-weekly-\d{4}-W\d{2}\.sqlite")
MONTHLY_PATTERN = re.compile(r"pp-calendar-monthly-\d{4}-\d{2}\.sqlite")


@dataclass(frozen=True, slots=True)
class BackupConfig:
    source: Path = Path("/srv/data/pp-calendar/calendar.sqlite")
    target_root: Path = Path("/srv/backups/pp-calendar")
    cloud_stage: Path = Path("/srv/data/aliyunpan/uploads")
    cloud_drive_id: str = "69183113"
    cloud_remote: str = "/pphk/pp-calendar"
    aliyunpan: Path = Path("/usr/local/bin/aliyunpan")
    keep_daily: int = 5
    keep_weekly: int = 4
    keep_monthly: int = 6
    sync_cloud: bool = True


@dataclass(frozen=True, slots=True)
class BackupResult:
    daily: Path
    weekly: Path
    monthly: Path
    daily_created: bool
    weekly_created: bool
    monthly_created: bool


def ensure_private_directory(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)
    path.chmod(0o700)


def check_sqlite(path: Path) -> None:
    with sqlite3.connect(f"file:{path}?mode=ro&immutable=1", uri=True) as connection:
        result = connection.execute("PRAGMA integrity_check").fetchone()[0]
    if result != "ok":
        raise RuntimeError(f"backup integrity check failed for {path}: {result}")


def create_daily_snapshot(source: Path, destination: Path) -> bool:
    if destination.exists():
        check_sqlite(destination)
        return False

    file_descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{destination.name}.", suffix=".tmp", dir=destination.parent
    )
    os.close(file_descriptor)
    temporary = Path(temporary_name)
    try:
        with sqlite3.connect(f"file:{source}?mode=ro", uri=True) as source_connection:
            with sqlite3.connect(temporary) as target_connection:
                source_connection.backup(target_connection)
                target_connection.execute("PRAGMA journal_mode=DELETE")
                result = target_connection.execute("PRAGMA integrity_check").fetchone()[0]
                if result != "ok":
                    raise RuntimeError(f"backup integrity check failed: {result}")
        temporary.chmod(0o600)
        temporary.replace(destination)
    except Exception:
        temporary.unlink(missing_ok=True)
        raise
    finally:
        Path(f"{temporary}-wal").unlink(missing_ok=True)
        Path(f"{temporary}-shm").unlink(missing_ok=True)
    return True


def promote_snapshot(source: Path, destination: Path) -> bool:
    if destination.exists():
        check_sqlite(destination)
        return False
    try:
        os.link(source, destination)
    except OSError:
        file_descriptor, temporary_name = tempfile.mkstemp(
            prefix=f".{destination.name}.", suffix=".tmp", dir=destination.parent
        )
        os.close(file_descriptor)
        temporary = Path(temporary_name)
        try:
            shutil.copyfile(source, temporary)
            temporary.chmod(0o600)
            check_sqlite(temporary)
            temporary.replace(destination)
        except Exception:
            temporary.unlink(missing_ok=True)
            raise
    check_sqlite(destination)
    return True


def tier_files(directory: Path, pattern: re.Pattern[str]) -> list[Path]:
    return sorted(
        (path for path in directory.iterdir() if path.is_file() and pattern.fullmatch(path.name)),
        key=lambda path: path.name,
    )


def rotate_tier(directory: Path, pattern: re.Pattern[str], keep: int) -> list[Path]:
    files = tier_files(directory, pattern)
    expired = files[:-keep] if len(files) > keep else []
    for path in expired:
        path.unlink()
    return expired


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def run_aliyunpan(config: BackupConfig, *arguments: str) -> str:
    completed = subprocess.run(
        [str(config.aliyunpan), *arguments],
        check=True,
        capture_output=True,
        text=True,
        timeout=180,
    )
    return completed.stdout


def remote_weekly_names(config: BackupConfig) -> list[str]:
    output = run_aliyunpan(
        config, "tree", "--driveId", config.cloud_drive_id, "-fp", config.cloud_remote
    )
    return sorted(set(WEEKLY_PATTERN.findall(output)))


def marker_path(state_directory: Path, weekly: Path) -> Path:
    return state_directory / f"{weekly.name}.sha256"


def write_marker(path: Path, digest: str) -> None:
    temporary = path.with_name(f".{path.name}.tmp")
    temporary.write_text(f"{digest}\n", encoding="ascii")
    temporary.chmod(0o600)
    temporary.replace(path)


def upload_weekly(config: BackupConfig, weekly: Path) -> None:
    config.cloud_stage.mkdir(parents=True, exist_ok=True)
    stage = config.cloud_stage / weekly.name
    if stage.exists():
        stage.unlink()
    try:
        shutil.copyfile(weekly, stage)
        account = pwd.getpwnam("aliyunpan")
        group = grp.getgrnam("aliyunpan")
        os.chown(stage, account.pw_uid, group.gr_gid)
        stage.chmod(0o600)
        run_aliyunpan(
            config,
            "upload",
            "--driveId",
            config.cloud_drive_id,
            "--np",
            "--timeout",
            "60",
            str(stage),
            config.cloud_remote,
        )
    finally:
        stage.unlink(missing_ok=True)


def sync_cloud_weeklies(config: BackupConfig, weekly_directory: Path, state_directory: Path) -> None:
    weeklies = tier_files(weekly_directory, WEEKLY_PATTERN)
    remote_names = remote_weekly_names(config)

    for weekly in weeklies:
        digest = sha256(weekly)
        marker = marker_path(state_directory, weekly)
        recorded = marker.read_text(encoding="ascii").strip() if marker.exists() else ""
        if weekly.name in remote_names:
            if recorded and recorded != digest:
                raise RuntimeError(f"local weekly backup changed after upload: {weekly.name}")
            if recorded != digest:
                write_marker(marker, digest)
            continue
        upload_weekly(config, weekly)
        remote_names = remote_weekly_names(config)
        if weekly.name not in remote_names:
            raise RuntimeError(f"uploaded weekly backup is not visible remotely: {weekly.name}")
        write_marker(marker, digest)

    current_names = {path.name for path in weeklies}
    for marker in state_directory.glob("pp-calendar-weekly-*.sqlite.sha256"):
        weekly_name = marker.name.removesuffix(".sha256")
        if weekly_name not in current_names:
            marker.unlink()

    remote_names = remote_weekly_names(config)
    for expired in remote_names[:-config.keep_weekly]:
        if not WEEKLY_PATTERN.fullmatch(expired):
            raise RuntimeError(f"refusing to remove unexpected remote filename: {expired}")
        run_aliyunpan(
            config,
            "rm",
            "--driveId",
            config.cloud_drive_id,
            f"{config.cloud_remote}/{expired}",
        )


def run_backup(config: BackupConfig, now: datetime | None = None) -> BackupResult:
    current = now or datetime.now().astimezone()
    auto_root = config.target_root / "auto"
    daily_directory = auto_root / "daily"
    weekly_directory = auto_root / "weekly"
    monthly_directory = auto_root / "monthly"
    state_directory = auto_root / ".state"
    for directory in (
        config.target_root,
        auto_root,
        daily_directory,
        weekly_directory,
        monthly_directory,
        state_directory,
        config.target_root / "manual",
        config.target_root / "legacy",
    ):
        ensure_private_directory(directory)

    daily = daily_directory / f"pp-calendar-daily-{current:%Y-%m-%d}.sqlite"
    iso_year, iso_week, _ = current.isocalendar()
    weekly = weekly_directory / f"pp-calendar-weekly-{iso_year}-W{iso_week:02d}.sqlite"
    monthly = monthly_directory / f"pp-calendar-monthly-{current:%Y-%m}.sqlite"

    daily_created = create_daily_snapshot(config.source, daily)
    weekly_created = promote_snapshot(daily, weekly)
    monthly_created = promote_snapshot(daily, monthly)

    rotate_tier(daily_directory, DAILY_PATTERN, config.keep_daily)
    rotate_tier(weekly_directory, WEEKLY_PATTERN, config.keep_weekly)
    rotate_tier(monthly_directory, MONTHLY_PATTERN, config.keep_monthly)

    if config.sync_cloud:
        sync_cloud_weeklies(config, weekly_directory, state_directory)

    return BackupResult(
        daily=daily,
        weekly=weekly,
        monthly=monthly,
        daily_created=daily_created,
        weekly_created=weekly_created,
        monthly_created=monthly_created,
    )


def main() -> None:
    result = run_backup(BackupConfig())
    print(
        "PP Calendar backup complete: "
        f"daily={result.daily.name} created={result.daily_created}, "
        f"weekly={result.weekly.name} created={result.weekly_created}, "
        f"monthly={result.monthly.name} created={result.monthly_created}"
    )


if __name__ == "__main__":
    main()
