# QQ Bot (官方机器人) 适配器

Yunzai NG 的 QQ 官方机器人适配器，通过 QQ 开放平台 API v2 接入，支持 WebSocket Gateway 与 Webhook 两种连接模式，
覆盖群聊、C2C 私聊、频道、频道私信四大场景。支持富媒体（图片 / 视频 / 语音 / 文件）发送、
多种 Markdown 发送模式与交互键盘。

本仓库是 [Yunzai NG](https://github.com/Yunzai-NG/yunzai-ng) 的官方可选插件，不随内核分发。

## 前置条件

1. 前往 [QQ 开放平台](https://q.qq.com) 注册开发者账号并创建机器人应用
2. 获取 **AppID** 和 **AppSecret**（应用管理 → 开发设置）
3. 根据使用场景选择连接方式：
   - **WebSocket Gateway**（推荐）：框架主动连接 QQ 官方 Gateway，实时接收事件
   - **Webhook 回调**：QQ 平台将事件 POST 至框架，适用于无法建立长连接的环境
4. 如需测试，可在应用管理中开启 **沙箱模式**

## 安装

推荐经面板的插件市场安装：面板 → 插件市场 → 搜索 `adapter-qqbot` → 安装。**装依赖与编译都由内核代跑**
（索引里声明了 `setup.scripts: ["build"]`），故这条路装完即可用 —— 本仓库的 `dist/` 不进 git，
不编译就没有入口。

亦可手工克隆至主目录的 `plugins/` 下，那时两步都要自己来：

```powershell
cd <主目录>\plugins
git clone https://github.com/Yunzai-NG/adapter-qqbot.git
cd adapter-qqbot
pnpm install
pnpm run build
```

随后在面板的插件页重载，或重启内核。

## 配置

在面板的账号页面添加 QQ Bot 账号，需填写以下配置项：

| 配置项 | 说明 | 默认值 |
|---|---|---|
| 连接方式 | `WebSocket Gateway` 或 `Webhook 回调` | WebSocket Gateway |
| AppID | QQ 开放平台分配的机器人 AppID | 必填 |
| AppSecret | QQ 开放平台分配的机器人密钥 | 必填 |
| 机器人 QQ 号 | 机器人的真实 QQ 号，用于日志显示 | 留空 |
| 事件订阅 | 预设订阅模式（仅 WebSocket 模式，见下方说明） | 群聊 |
| 分片配置 | 格式：`分片ID/分片总数`，如 `0/1`（仅 WebSocket 模式） | 0/1 |
| 沙箱模式 | 启用后将使用沙箱环境进行测试 | 关闭 |
| 频道 Markdown | 启用后频道消息将使用 Markdown 格式发送 | 关闭 |
| 群聊 Markdown | 启用后群聊消息将使用 Markdown 格式发送 | 关闭 |
| Markdown 模式 | Markdown 总开关开启时采用的发送策略（见下方说明） | 原生 Markdown |
| Markdown 模板 ID | 模板模式使用的 `custom_template_id` | 留空 |
| 模板参数键 | 按顺序填写模板参数 key，如 `abcdefghij` | abcdefghij |
| 键盘模板 ID | 留空时按消息按钮内容生成键盘，填写后使用平台按钮模板 | 留空 |
| 转发消息格式 | `合并` 或 `多条`（见下方说明） | 合并 |
| 图片压缩上限 | sharp 可用时将超限图片压缩；未安装则原样发送（MiB） | 4 |
| 图床脚本路径 | 自定义图床 JS 脚本路径，用于 Markdown 消息中发送图片 | 留空 |
| 文件服务地址 | Markdown 图片内置文件路由的对外基址（见下方说明） | 留空 |
| Webhook 监听路径 | Webhook 模式下接收事件的 URL 路径 | /qqbot |

### Markdown 发送

**频道 Markdown** 与 **群聊 Markdown** 是分场景的总开关，开启后按 **Markdown 模式** 选定的策略发送：

| 模式 | 说明 |
|---|---|
| 原生 Markdown | 原生 Markdown 消息 + 交互键盘（按钮渲染为 QQ 键盘） |
| 内联指令 | 原生 Markdown + 文本指令链（按钮转为可点击的文本指令） |
| 模板 Markdown | 按配置的模板 ID 与参数键发送，内容超出参数槽位自动拆分为多条 |
| 纯文本 | 禁用富 Markdown，按普通文本消息拆分发送 |

> 模板模式未填写模板 ID 时自动退回纯文本。

**Markdown 图片**：QQ 的 Markdown 消息无法走富媒体接口，图片必须转为公网 URL 后以
`![摘要 #宽px #高px](url)` 语法嵌入（QQ 要求 Markdown 图片显式声明尺寸，适配器会自动解析图片宽高）。
适配器按以下优先级选取通道：

1. **图床脚本**（配置 `图床脚本路径`，见下方图床配置）
2. **内置文件服务**（配置 `文件服务地址`，见下方文件服务配置）

两个通道都不可用时，图片降级为文本占位并在日志输出告警。

### 文件服务配置

未配置图床脚本时，适配器把图片发布到内置的 `/plugin/adapter-qqbot/file/:name` 路由，供 QQ 服务器拉取：

- **文件服务地址**：该路由的对外基址。留空时使用内核面板的公网地址；也可填写自定义地址
  （如 `http://192.168.1.2:2536` 或内网穿透域名）
- 文件保留 5 分钟（QQ 在渲染消息时即刻拉取），最多驻留 100 个，超限自动淘汰
- 地址为回环地址（`localhost` / `127.0.0.1`）时会在日志告警 —— QQ 客户端无法拉取本机回环地址上的图片

### 图床配置

配置 `图床脚本路径` 后，Markdown 图片优先经自定义图床转为公网 URL。

**脚本要求**：
- 导出一个函数（`export default` 或 `export function upload`）
- 函数接收参数：`data`（图片 Buffer）、`options`（`{ filename, mimeType }`）
- 返回 `Promise<string>`，即图片的公网 URL

**示例脚本**：

```javascript
// D:\my-image-host.js
const Token = 'YOUR_TOKEN'

export default async function upload(data, options) {
  const formData = new FormData()
  formData.append('files', new File([data], options.filename || 'image.png', {
    type: options.mimeType || 'image/png'
  }))

  const res = await fetch('https://api.kurobbs.com/forum/uploadForumImgForH5', {
    method: 'POST',
    body: formData,
    headers: {
      'User-Agent': 'Mozilla/5.0 ...',
      'source': 'h5',
      'Referer': 'http://www.kurobbs.com/',
      'Token': Token
    }
  })

  const result = await res.json()
  return result.data[0]
}
```

图床上传失败时自动降级内置文件服务。

### 富媒体与转发消息

QQ 平台限制一条消息只能携带一个富媒体元素，适配器会把含多个富元素的消息自动拆分为多条按序发送。

| 场景 | 图片 | 视频 | 语音 | 文件 |
|---|---|---|---|---|
| 群聊 / C2C 私聊 | 富媒体 | 富媒体 | 富媒体 | 富媒体 |
| 频道 / 频道私信 | multipart 或 URL | 降级文本 | 降级文本 | 降级文本 |

群聊 / C2C 私聊走 QQ 官方富媒体接口（`msg_type: 7`）：

- 源为公网 URL 时优先交给平台转存；转存失败时在本机下载后走官方分片上传
- 其余来源（本地路径 / Buffer / base64）走官方分片上传协议：预上传 → 并发 PUT 分片 → 合并，
  自动计算 MD5 / SHA1 校验并按服务端配置重试
- 此回退只影响群聊 / C2C 原生富媒体；Markdown 图片仍必须使用公网 URL 嵌入 Markdown

频道场景的本地图片走 multipart `file_image` 直传，公网 URL 图片直接填 `image` 字段。

**接收附件**：群聊、C2C 私聊、频道与频道私信收到的 QQ `attachments` 会统一转换为内核消息段：

| QQ 附件 MIME 类型 | 内核消息段 |
|---|---|
| `image/*` | `image` |
| `audio/*` | `record` |
| `video/*` | `video` |
| 其他类型（PDF、压缩包、Office 文档等） | `file` |

`file` 段保留 QQ 提供的下载 URL、原始文件名和文件大小；适配器不会在接收时下载附件，后续由使用方按需处理。

**转发消息格式**：

| 格式 | 说明 |
|---|---|
| 合并 | 转发的多个节点合并进一条消息发送 |
| 多条 | 转发的每个节点各自作为一条消息发送 |

含图片 / 视频等富媒体的节点因平台单条限制仍会单独成条；无法展开的转发段降级为文本占位。

### Webhook 模式配置

选择 **Webhook 回调** 连接方式后，需完成以下步骤：

1. **确保 yunzai-ng 有公网可访问的地址**（如通过 frp、ngrok 等内网穿透工具）
2. **在面板填写配置**：
   - 连接方式：选择 `Webhook 回调`
   - AppID：QQ 开放平台的 AppID
   - AppSecret：QQ 开放平台的 AppSecret（用于 Ed25519 签名验证）
3. **在 QQ 开放平台配置回调地址**：
   - 进入 [QQ 开放平台管理端](https://q.qq.com/qqbot/#/developer/webhook-setting)
   - 回调地址填写格式：`https://你的公网域名:端口/plugin/adapter-qqbot/qqbot`
   - 允许的端口号：80、443、8080、8443
4. **保存回调地址**：平台会发送 op=13 验证请求，适配器自动返回签名完成验证

> **注意**：回调地址必须是 HTTPS，且端口号在允许范围内。如果使用内网穿透，确保穿透工具监听的是允许端口。

多个 QQ Bot 账号共用同一条回调路由，适配器按请求头 `X-Bot-Appid` 区分账号，
无需为每个账号配置不同的回调地址。

### 事件订阅预设

| 预设 | 说明 | 适用场景 |
|---|---|---|
| 频道公域 | 公域频道消息 + 基础事件 | 公域机器人 |
| 频道私域 | 私域频道消息 + 论坛事件 + 基础事件 | 私域机器人 |
| 群聊 | 群聊和 C2C 私聊事件 | 群聊机器人 |
| 频道公域 + 群聊 | 公域频道 + 群聊 | 同时接入频道和群 |
| 频道私域 + 群聊 | 私域频道 + 群聊 | 同时接入频道和群 |

> **注意**：频道公域和私域不能同时订阅，这是 QQ 开放平台的限制。

各订阅预设可接收的事件清单、内核事件模型的完成度对照见 [docs/EVENTS.md](docs/EVENTS.md)。

### 沙箱模式

开启沙箱模式后：
- WebSocket 连接地址切换为 `wss://sandbox.api.sgroup.qq.com/websocket`
- API 请求地址切换为 `https://sandbox.api.sgroup.qq.com`
- 仅能接收沙箱环境中的测试事件，适用于开发调试

## 开发

本插件依赖 `@yunzai-ng/core` 与 `@yunzai-ng/types`，两者声明为 `peerDependencies`
（运行期由宿主内核提供，插件目录内不应再装一份）。**框架发布至 npm 之前**，需先链接本地
框架 checkout：

```powershell
git clone https://github.com/Yunzai-NG/yunzai-ng.git
cd yunzai-ng
pnpm install
pnpm run build          # 必需：本插件的 tsc 读取框架的 dist/*.d.ts

cd ..\adapter-qqbot
pnpm install
pnpm run build
```

常用脚本：

```powershell
pnpm run build    # 编译（tsc -b）
pnpm run test     # 运行 vitest 测试
pnpm run lint     # ESLint 检查
pnpm run verify   # build + 测试类型检查 + lint + test 一键校验
```

增强依赖 `sharp` / `qrcode` / `silk-wasm` 声明为 `optionalDependencies`：
未安装时相关增强功能自动降级，基础收发不受影响。

## API 参考

详见 [API-REFERENCE.md](docs/API-REFERENCE.md)。

## 许可

AGPL-3.0-or-later
