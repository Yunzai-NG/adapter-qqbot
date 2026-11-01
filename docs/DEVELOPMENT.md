# 开发

## 源码布局

按**领域**分目录，依赖只能从下往上单方向引用，同层不互相 import：

| 目录 | 职责 | 关键文件 |
|---|---|---|
| `src/index.ts` | 插件入口：注册适配器、Webhook 路由与文件路由 | — |
| `src/config.ts` | 账号配置 schema、校验与旧配置迁移 | — |
| `src/protocol/` | 平台协议：报文 DTO、段编解码、Markdown、图文卡片、文本交互标签 | `types` `codec` `markdown` `card` `interaction` |
| `src/transport/` | 与平台的 IO：令牌、HTTP 调用、WebSocket、Webhook（含签名与注册表）、富媒体上传 | `auth` `api` `gateway` `webhook` `upload` |
| `src/media/` | 媒体：字节解析、三级图床、各链路图片阈值、官方素材清理、框架文件服务 | `resolve` `image-to-url` `limits` `official-image-host` `file-server` `probe` |
| `src/messaging/` | 消息编解码：平台事件 → 内核事件，内核段 → 出站计划 | `inbound` `outbound` |
| `src/bot/` | BotDriver 组合：上下文、连接、发送、查询、群管 | `context` `connection` `send` `query` `manage` |
| `src/shared/` | 零业务语义的通用工具：公网地址判定、可选依赖加载 | `public-url` `optional-deps` |

依赖方向（箭头表示「允许依赖」）：

```
shared ← protocol ← transport ← media ← messaging ← bot ← index
```

`protocol` 全是纯函数与类型，不碰网络与文件；一旦某段逻辑需要 `fetch` 或 `readFile`，它就不属于 `protocol`。

各目录的 `index.ts` 是该领域的统一出口，外部（入口与测试）只认出口、不深引实现文件。

## 环境

本插件依赖 `@yunzai-ng/core` 与 `@yunzai-ng/types`，两者声明为 `peerDependencies`（运行期由宿主内核提供，插件目录内不应再装一份）。

增强依赖 `sharp` / `qrcode` / `silk-wasm` 声明为 `optionalDependencies`，装载统一走 `src/shared/optional-deps.ts` 的懒加载（进程内记忆化，缺失只告警一次），整形逻辑在 `src/media/transform.ts`：`sharp` 压超限图片，`silk-wasm` 转 SILK 语音（非 WAV 先借 ffmpeg 解码）。未安装时对应能力自动降级，基础收发不受影响。`qrcode` 目前只有装载器、没有调用方（扫码绑定与链接转二维码均未实现），接线位置预留在 `src/shared/optional-deps.ts`。

<details>
<summary>link:framework 的行为</summary>

- 查找顺序：`YZNG_FRAMEWORK` → `../yunzai-ng` → `../../yunzai-ng` → `../../code`，三个包目录齐备即认定为框架根
- 链接 `@yunzai-ng/core`、`@yunzai-ng/types`、`@yunzai-ng/jsx` 到 `node_modules/@yunzai-ng/`
- Windows 上用 junction 而非 symlink，不需要开发者模式或管理员权限
- `node_modules/@yunzai-ng/` 下已存在的**真实目录**会被跳过，避免覆盖 pnpm 装下的发布版
- 框架未构建（缺 `dist/index.d.ts`）时给出提示，不会静默失败
- 找不到框架时报错退出，提示设置 `YZNG_FRAMEWORK`

</details>

## 脚本

```powershell
pnpm run build           # 编译（tsc -b）
pnpm run test            # vitest 测试
pnpm run lint            # ESLint 检查
pnpm run link:framework  # 链接本地框架 checkout（框架未发布 npm 时）
pnpm run verify          # build → typecheck:test → lint → test
```
