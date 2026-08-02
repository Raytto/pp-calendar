# PP Calendar

PP 私人日历，公网入口为 `https://calendar.pangruitao.com/`。功能借鉴 Google Calendar 的月视图体验，视觉沿用 PP Agent 的深靛蓝、琥珀黄与浅色纸面风格。

## 功能

- 仅支持按天记录的月视图；支持前后翻月、回到今天、触控左右滑动。
- 点击任意日期创建事件；可查看、编辑、删除标题、日期、所属日历和备注。
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
