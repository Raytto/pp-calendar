# 事件图片与 Agent 调用

2026-09-10 新增通用事件图片。餐食描述、热量、营养及估算依据保存在原有 `notes` 纯文本字段中；没有新增饮食数据库或营养字段。

## 存储和边界

- `event_images` 通过 `event_id` 关联事件，外键 `ON DELETE CASCADE`；表内保存独立 WebP 图片、缩略图及文件名、原输入 SHA-256、尺寸、大小、创建时间。
- 图片输入上限20 MiB／5000万像素，每事件最多12张；允许 JPEG、PNG、WebP、HEIC／HEIF 静态图片。解码器实际校验内容，不信任文件扩展名或 MIME；不接收服务器路径或远程取图 URL。
- 使用 Pillow 与 pillow-heif 校正方向、剥离 EXIF／GPS 等元数据，最大边缩放到2560px；缩略图最长边320px。保存的是供查看的高质量转换版本，不是原始文件无损归档；同一输入在不同事件可各自保存，同事件重复上传返回原记录。
- 图片内容直接随 SQLite 在线快照、日周月保留和异机周备份一起恢复，不依赖 PPA 会话附件、文件目录一致性或新对象存储服务。该选择适合个人规模，代价是数据库及全量备份会随图片增长。删除释放数据库可复用空间，不保证文件立即缩小；已有备份按保留周期过期。
- 大图和缩略图都依赖现有登录认证，写操作需要 CSRF；响应 `private, no-store`、`nosniff`。静态目录不存图片。
- 图片处理在工作线程执行，事务中复核事件存在、上限与重复内容；原始上传不产生磁盘暂存文件。删除和图片上传是独立提交；文字保存成功但图片失败会保留事件与未完成操作，重试不另建事件。

## 前端

- 新建／编辑弹窗支持多选、预览、移除；选择和移除先保留在浏览器，点“保存”才提交，取消不会删除已保存图片。
- 详情弹窗按需加载缩略图；点击查看大图，支持上／下一张、放大／适应窗口和键盘左右键。手机保留平移和双指缩放。
- HEIC 浏览器本地预览可能不可用；上传转换后可正常显示。
- 月视图不加载图片列表或二进制，不增加图片占位。注销会关闭图片弹窗并清理预览引用。
- `/month/YYYY/M/1#event-ID` 可以直达事件详情；未登录先登录再打开目标记录。
- 图片请求失败与文字保存失败分开反馈。若服务器已经保存图片但响应丢失，重试按原输入哈希去重。

## HTTP API

全部要求现有 Session。POST／DELETE 还要求 `X-CSRF-Token`。

| 接口 | 语义 |
|---|---|
| `GET /api/events/{event_id}/images` | 有序图片元数据，含大图及缩略图 URL，不含 BLOB |
| `POST /api/events/{event_id}/images?name=...` | 请求体是单张图片的原始字节；201，返回 `image` 和 `replayed` |
| `GET /api/events/{event_id}/images/{image_id}` | WebP 大图；加 `?thumbnail=true` 取缩略图 |
| `DELETE /api/events/{event_id}/images/{image_id}` | 删除单图；同事件重复删除幂等 |

事件创建、修改、查询和删除继续使用原接口。不存在的父事件返回404；无认证401、CSRF错误403、大小／像素限制413、不能解码415、达到数量上限409。

Nginx `client_max_body_size` 从1m调至20m，与单图接口匹配。每张图单独请求；应用流式读取同样检查20 MiB上限，包括没有 Content-Length 的请求。

## PPHK 宿主工具

入口：在工程目录执行 `.venv/bin/python -m app.agent_cli --help`。PPHK Manage 的 `pp-calendar` skill 包装此入口；仅 root 本机使用，不对其他 PPA 账号提供越权通道。

工具先创建有效期10分钟的临时 Session，在结束时撤销；不读取日历密码，不输出 Cookie，不调用公开登录来猜密码。短会话认证表维护是唯一直接数据库写入，事件与图片均经过 API。调用8771回环接口前按服务 MainPID 比对并进入正确网络命名空间。仅接受127.0.0.1 HTTP地址；测试可用 `--database` 与 `--base-url` 指向隔离实例。

常用命令：

```text
calendars
events --start YYYY-MM-DD --end YYYY-MM-DD [--query 关键词]
get --id ID
create --payload-file event.json --request-id STABLE_ID [--image photo.jpg ...]
update --id ID --payload-file changes.json [--image photo.jpg ...]
upload-image --id ID --file photo.jpg
delete-image --id ID --image-id IMAGE_ID
download-image --id ID --image-id IMAGE_ID --output new-file.webp
delete --id ID
```

创建要求稳定请求 ID（16–128位英数字及 `._:-`），重试复用；修改走 `update`。创建／修改如有图片失败仍返回已经保存的事件 ID、`complete=false` 和 `image_errors`，退出码2。其他错误退出码1。下载使用独占新文件创建，避免覆盖既有文件。日期查询超过120天须由调用方分段，关键词搜索工具会遍历所有页。

## 验证记录

- 自动测试覆盖图片鉴权、跨事件访问、大小／格式／数量限制、EXIF方向与清理、HEIC转换、重试去重、事件级联删除、既有结构升级、SQLite备份还原图像及备注、工具部分失败与会话撤销。
- 隔离浏览器以1440×1000与390×844跑新建多图、详情缩略图、深链接、大图切换／放大、移除后取消、移除后保存，以及模拟成功响应丢失后的重试；无页面横向溢出、pageerror为0。
- 手机尺寸自动化不能替代真实iPhone相机／Safari验收。真实生产验收结果记录在本机知识库的 PP Calendar 项目入口。

处理参考：[Pillow Image 文档](https://pillow.readthedocs.io/en/stable/reference/Image.html)、[pillow-heif 插件文档](https://pillow-heif.readthedocs.io/en/latest/pillow-plugin.html)。
