# adapter-qqbot

Yunzai NG 的 QQ 官方机器人适配器，走 QQ 开放平台 API v2，支持群聊、C2C 私聊、频道、频道私信，连接方式可选 WebSocket Gateway 或 Webhook 回调。

本仓库是 [Yunzai NG](https://github.com/Yunzai-NG/yunzai-ng) 的可选插件，不随内核分发。

> **配套图床插件**｜Markdown 图片需要公网地址时，可直接接入 [ImageBed-Plugin](../ImageBed-Plugin/README.md)：
> 它实现了本适配器的 `qqbot.imageToUrl`，按你配置的优先级把图片转存到 CNB / COS / PicGo / 自建 HTTP 等图床，
> 失败自动回落到官方素材库与框架图床。装完即生效，无需改动本适配器。

## 前置条件

1. 到 [QQ 开放平台](https://q.qq.com) 注册开发者账号，创建机器人应用
2. 在「开发设置」取得 **AppID** 与 **AppSecret**
3. 机器人需按使用场景获得对应能力：群聊需要群能力，频道需要频道能力
4. 调试阶段建议开启 **沙箱模式**，用沙箱环境的测试事件联调

## 安装

面板 → 插件市场 → 搜索 `adapter-qqbot` → 安装。依赖安装与编译由内核代跑，装完即用。

手工安装时两步都要自己做：

```powershell
cd <主目录>\plugins
git clone https://github.com/Yunzai-NG/adapter-qqbot.git
cd adapter-qqbot
pnpm install
pnpm run build
```

完成后在面板重载插件，或重启内核。

## 配置

面板 → 账号页面 → 添加 QQ Bot 账号。

账号设置分「基础信息」「消息」「图片」三组，全部可选项如下。

### 基础信息

| 配置项          | 说明                                  | 默认值               |
| ------------ | ----------------------------------- | ----------------- |
| 连接方式         | `WebSocket Gateway` 或 `Webhook 回调`  | WebSocket Gateway |
| AppID        | QQ 开放平台分配的机器人 AppID                | 必填                |
| AppSecret    | QQ 开放平台分配的机器人密钥，用于取 Access Token 与签名验证 | 必填                |
| 机器人 QQ 号     | 真实 QQ 号，仅用于日志显示；留空则显示 open_id       | 留空                |
| 事件订阅         | 预设订阅模式，仅 WebSocket 模式               | 群聊                |
| 分片配置         | `分片ID/分片总数`，如 `0/1`，仅 WebSocket 模式 | 0/1               |
| 沙箱模式         | 使用沙箱环境测试                            | 关闭                |
| Webhook 监听路径 | Webhook 模式下接收事件的 URL 路径，须以 `/` 开头   | /qqbot            |

#### 事件订阅预设

| 预设        | 包含事件                 | 适用场景      |
| --------- | -------------------- | --------- |
| 频道公域      | 公域频道消息 + 基础事件        | 公域机器人     |
| 频道私域      | 私域频道消息 + 论坛事件 + 基础事件 | 私域机器人     |
| 群聊        | 群聊与 C2C 私聊事件         | 群聊机器人     |
| 频道公域 + 群聊 | 公域频道 + 群聊            | 频道与群聊同时接入 |
| 频道私域 + 群聊 | 私域频道 + 群聊            | 频道与群聊同时接入 |

频道公域与频道私域不能同时订阅，这是 QQ 开放平台的限制。各预设的事件清单见 [docs/EVENTS.md](docs/EVENTS.md)。

#### Webhook 回调

1. 准备公网可访问地址（frp、ngrok 等内网穿透均可）
2. 面板把连接方式改为 `Webhook 回调`，填 AppID 与 AppSecret（后者用于 Ed25519 签名验证）
3. 在 [Webhook 设置](https://q.qq.com/qqbot/#/developer/webhook-setting) 填回调地址
   `https://你的公网域名:端口/plugin/adapter-qqbot/qqbot`
4. 保存时平台会发 `op=13` 验证请求，适配器自动返回签名完成验证

地址必须 HTTPS，端口只能是 **80 / 443 / 8080 / 8443**。多个账号可共用同一条回调路由，适配器按请求头 `X-Bot-Appid` 区分，无需为每个账号配不同地址。

#### 沙箱模式

开启后 WebSocket 地址切换为 `wss://sandbox.api.sgroup.qq.com/websocket`、API 地址切换为 `https://sandbox.api.sgroup.qq.com`，只能收到沙箱环境的测试事件，适用于开发调试。

### 消息

| 配置项            | 说明                          | 默认值         |
| -------------- | --------------------------- | ----------- |
| 频道 Markdown    | 频道消息用 Markdown 发送，需原生 md 权限 | 关闭          |
| 群聊 Markdown    | 群聊消息用 Markdown 发送，需 Markdown 权限 | 关闭          |
| Markdown 模式    | 上述开关打开后的发送策略                | 原生 Markdown |
| Markdown 模板 ID | `template` 模式使用的 `custom_template_id` | 留空          |
| 模板参数键          | `template` 模式的模板参数 key，按顺序填写  | abcdefghij  |
| 键盘模板 ID        | 留空按消息按钮生成键盘，填写则用平台按钮模板      | 留空          |
| 转发消息格式         | `合并` 或 `多条`                 | 合并          |

Markdown 模式取值：

- `原生 Markdown`：Markdown 消息 + 交互键盘
- `内联指令`：Markdown + 文本指令链（按钮转为可点击文本）
- `模板 Markdown`：按模板 ID 与参数键发送，需填上面两项；未填模板 ID 时退回纯文本
- `纯文本`：禁用富 Markdown，按普通文本拆分发送

频道与群聊是分场景独立开关。转发消息选 `合并` 时多节点拼成一条，选 `多条` 时每节点一条；含图片 / 视频的节点因平台限制仍会单独成条。消息段能力与平台限制见 [docs/MESSAGING.md](docs/MESSAGING.md)。

### 图片

| 配置项           | 说明                                        | 默认值   |
| ------------- | ----------------------------------------- | ----- |
| 官方图床          | 上传到 QQ 素材库换 `qqbot-media://` 引用，不依赖公网地址 | 开启    |
| 文件服务地址        | 框架图床的对外基址，留空则用内核面板地址                      | 留空    |
| 图片保存时间（秒）     | 素材保留时间，同时是去重有效期与配额清理判定线，范围 60 - 7776000   | 14400 |
| 频道图片压缩上限（MiB） | **只对频道图片**生效：超过该值才压（先降质量、再缩边长）；群聊 / 单聊按平台软限 20 MB、Markdown 素材库按 10 MB 各自处理；未装 sharp 时原样发送 | 4     |

图片取址按「自定义图床 → 官方图床 → 框架图床」逐级降级，`文件服务地址` 填内网或回环地址时框架图床会被跳过（QQ 拉不到），保存时面板会提示。链路细节与自定义图床写法见 [docs/MEDIA.md](docs/MEDIA.md)。

自定义图床不必自己写：装 [ImageBed-Plugin](../ImageBed-Plugin/README.md) 即可，它已实现 `qqbot.imageToUrl`，按你配置的优先级（CNB、COS、PicGo、自建 HTTP 等）转存图片，失败返回空值由适配器继续走官方素材库与框架文件服务。

### 语音

QQ 语音只认 SILK。发送 `record` 段时按下面的顺序处理，每一步失败都退回「原样上传」，不会因此发不出去：

| 顺序 | 条件                | 动作                                       |
| -- | ----------------- | ---------------------------------------- |
| 1  | 已经是 SILK          | 直接上传，不做二次编码                             |
| 2  | 是 WAV（或 pcm_s16le） | silk-wasm 直接编码（WAV 采样率由头部解析）              |
| 3  | 其他格式（mp3 / amr / ogg） | ffmpeg 解码成 24 kHz 单声道 PCM，再交给 silk-wasm |
| 4  | 前三步都不成立           | 原样按语音上传，日志记一条 debug                      |

- `silk-wasm` 未安装：整条转码链路关闭，语音原样上传
- `ffmpeg` 未安装：只有 WAV 能转，其他格式原样上传；可用环境变量 `FFMPEG_PATH` 指向宿主自带的二进制（不在 PATH 上时）
- 语音直链（如收到的语音再转发）若不是 `.silk`，适配器会先取回字节在本机转码，再走分片上传，而不是交给平台转存

## 可选依赖

三个依赖都是 `optionalDependencies`，装不上不影响基础收发，只影响对应的增强能力：

| 依赖          | 用途                          | 缺失时            |
| ----------- | --------------------------- | -------------- |
| `sharp`     | 频道图片按配置上限压缩；群聊 / 图床按平台自身上限压缩 | 图片原样发送         |
| `silk-wasm` | 语音转 SILK                     | 语音原样上传         |
| `qrcode`    | 预留（扫码绑定 / 链接转二维码等场景，当前未接线）    | 无影响            |

## 配套插件

- **[ImageBed-Plugin](../ImageBed-Plugin/README.md)** —— 现成的自定义图床。它实现 `qqbot.imageToUrl`，按优先级把图片转存到 CNB / COS / PicGo / 自建 HTTP 等图床，转不了交给官方素材库与框架图床兜底。安装与配置见 [docs/MEDIA.md](docs/MEDIA.md#现成实现imagebed-plugin)。

## 开发

依赖 `@yunzai-ng/core` 与 `@yunzai-ng/types`（`peerDependencies`，运行期由宿主内核提供）。框架发布到 npm 之前，需先把本地框架 checkout 链接进来：

```powershell
pnpm install
pnpm run link:framework   # 按 YZNG_FRAMEWORK → ../yunzai-ng → ../../yunzai-ng → ../../code 查找
pnpm run verify           # build → typecheck:test → lint → test
```

框架需已构建，`tsc` 读的是它的 `dist/*.d.ts`。

插件直接放在框架仓库的 `plugins/` 下开发时，相对路径找不到框架，需显式指定位置：

```powershell
$env:YZNG_FRAMEWORK = "<框架仓库根>"
pnpm run link:framework
```

源码布局与依赖方向见 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)。

## 文档

- [docs/MESSAGING.md](docs/MESSAGING.md)：Markdown、图文卡片、富媒体、转发、接收附件、消息去重
- [docs/MEDIA.md](docs/MEDIA.md)：三级图床与图片地址配置
- [docs/API-REFERENCE.md](docs/API-REFERENCE.md)：内核 BotApi 方法与 QQ 接口对照
- [docs/EVENTS.md](docs/EVENTS.md)：事件订阅清单
- [docs/CORE-EVENTS.md](docs/CORE-EVENTS.md)：内核事件模型
- [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)：源码布局、环境与脚本

## 许可

AGPL-3.0-or-later
