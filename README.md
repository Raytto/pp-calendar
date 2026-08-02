# PP Calendar

PP 私人日历，公网入口为 `https://calendar.pangruitao.com/`。功能借鉴 Google Calendar 的月视图体验，视觉沿用 PP Agent 的深靛蓝、琥珀黄与浅色纸面风格。

源码仓库：`https://github.com/Raytto/pp-calendar`。数据库、环境变量、证书私钥和日历导入原始文件均不进入 Git。

## 功能

- 仅支持按天记录的月视图；支持前后翻月、回到今天、触控左右滑动。
- 月份使用可复制的 `/month/YYYY/M/1` 深链接；点击顶部年月可直接选择并跳转到任意月份，支持刷新与浏览器前进/后退。
- 点击任意日期创建事件；可查看、编辑、删除标题、日期、所属日历和备注。
- 高密度日期会按窗口高度自适应显示事件，并在底部显示可点击的“另有 N 项”；当天事项窗口可滚动查看全部事件、进入详情或直接新增当天记录。
- 每个事件只属于一个日历；日历支持创建、改名、换色、显示/隐藏与删除空日历。
- 关键词搜索覆盖事件标题、备注和日历名称。
- 桌面端保留 PP Agent 风格常驻侧栏；手机端使用月份快捷条、全月网格、抽屉式日历列表和浮动新建按钮。
- 外观支持浅色、深色与跟随系统，并在浏览器中记住选择；设置入口位于侧栏底部的 PP 账号区。
- 单账号登录、服务端 Session、CSRF、登录限速与安全响应头。

## 运行映射

- 源码：`/srv/workspace/pp-calendar`
- 持久数据：`/srv/data/pp-calendar/calendar.sqlite`
- 服务：`pp-calendar.service`，监听 `127.0.0.1:8771`
- 配置：`/etc/pp-calendar.env`（仅 root 可读，不进入 Git）
- Nginx：`/etc/nginx/sites-available/pp-calendar.conf`
- 证书：`/root/certs/calendar.pangruitao.com/`
- 备份：`pp-calendar-backup.timer` 每日创建 SQLite 在线一致性副本到 `/srv/backups/pp-calendar/`，保留 30 份

## 本地开发与测试

```bash
uv sync --dev
PP_CALENDAR_DB=/tmp/pp-calendar.sqlite \
PP_CALENDAR_USERNAME=PP \
PP_CALENDAR_PASSWORD_HASH="$(uv run python -m app.main hash-password 'temporary-password')" \
uv run uvicorn app.main:app --host 127.0.0.1 --port 8771

uv run pytest -q
```

真实密码只保存在服务器 `/etc/pp-calendar.env` 的哈希中；明文不写入源码、Git、数据库或知识库。

## Google Calendar 数据导入

2026-08-03 从 Google Calendar Takeout 的 9 个 ICS 日历导入 7,310 条原始事件；24 条年度重复规则被展开为实际日期，最终写入 9,082 条按日记录，范围为 1994-01-08 至 2100-12-31。另按原日历列表恢复了 ICS 不包含的空 `Tasks` 分类，合计 10 个日历分类。

导入前快照位于 `/srv/backups/pp-calendar/pre-google-import-20260803-013033.sqlite`。该快照只有导入前的 4 个默认日历和 0 条事件。
