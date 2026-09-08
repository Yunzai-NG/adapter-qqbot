# QQ Bot (官方机器人) 适配器

Yunzai NG 的 QQ 官方机器人适配器，通过 QQ 开放平台 API v2 接入，支持 WebSocket Gateway 与 Webhook 两种连接模式，
覆盖群聊、C2C 私聊、频道、频道私信四大场景。

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
| 事件订阅 | 预设订阅模式（见下方说明） | 群聊 |
| 分片配置 | 格式：`分片ID/分片总数`，如 `0/1` | 0/1 |
| 沙箱模式 | 启用后将使用沙箱环境进行测试 | 关闭 |
| 频道 Markdown | 启用后频道消息将使用 Markdown 格式发送 | 关闭 |
| 群聊 Markdown | 启用后群聊消息将使用 Markdown 格式发送 | 关闭 |
| 图床脚本路径 | 自定义图床 JS 脚本路径，用于 Markdown 消息中发送图片 | 留空 |
| Webhook 监听路径 | Webhook 模式下接收事件的 URL 路径 | /qqbot |

> **Markdown 说明**：启用 Markdown 发送后，图片会通过图床上传为公网 URL，以 `![image #Wpx #Hpx](url)` 语法嵌入 Markdown 消息发送。
> QQ Bot 的 Markdown 图片必须带尺寸，适配器会自动解析图片宽高。

### Webhook 模式配置

选择 **Webhook 回调** 连接方式后，需完成以下步骤：

1. **确保 yunzai-ng 有公网可访问的地址**（如通过 frp、ngrok 等内网穿透工具）
2. **在面板填写配置**：
   - 连接方式：选择 `Webhook 回调`
   - AppID：QQ 开放平台的 AppID
   - AppSecret：QQ 开放平台的 AppSecret（用于 Ed25519 签名验证）
   - Webhook 监听路径：默认 `/qqbot`，可自定义
3. **在 QQ 开放平台配置回调地址**：
   - 进入 [QQ 开放平台管理端](https://q.qq.com/qqbot/#/developer/webhook-setting)
   - 回调地址填写格式：`https://你的公网域名:端口/plugin/adapter-qqbot/qqbot`
   - 允许的端口号：80、443、8080、8443
4. **保存回调地址**：平台会发送 op=13 验证请求，适配器自动返回签名完成验证

> **注意**：回调地址必须是 HTTPS，且端口号在允许范围内。如果使用内网穿透，确保穿透工具监听的是允许端口。

### 图床配置

QQ Bot 的 Markdown 消息（`msg_type: 2`）无法直接发送图片，需要将图片上传到图床获取公网 URL 后嵌入 Markdown 内容。

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

在账号配置中填写脚本路径即可启用。适配器会在发送 Markdown + 图片时自动调用图床上传。

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

## API 参考

详见 [API-REFERENCE.md](docs/API-REFERENCE.md)。

## 许可

AGPL-3.0-or-later
