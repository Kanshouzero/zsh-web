# Hub · 个人超级 App（iOS / SwiftUI）

自用的原生 iOS「超级 App」，把各类自托管工具收进一个 App。主要自己用，通过自己的
Apple 开发者账号走 **TestFlight / 真机直装** 分发（不公开上架——纯自用 App 容易被
App Store 4.2/4.3 拒）。

## 架构

> **原生客户端 ↔ 自托管后端**：每个模块只是某个后端 API 的客户端；后端是耐用、可控的
> 那一层，App 永不过期、不被下架、不受 iOS 旧二进制淘汰影响。

```
SwiftUI App (本仓库)
   └─ 用量模块  ──HTTP──▶  cc-monitor 后端（NAS 上 Docker，见 ../main-web）
   └─ 终端模块  ──HTTP/WS─▶ zsh-web Hub（NAS 上 Docker，见 ../hub.js）
   └─ NAS 模块  （规划中）
   └─ 下载模块  （规划中）
```

第一个模块「用量」对接 cc-monitor 的接口：

| 用途 | 接口 |
|---|---|
| 登录（密码 → 会话 cookie） | `POST /api/login` |
| 拉账号列表 + 用量 | `GET /api/accounts` |
| 强制刷新某账号用量 | `POST /api/accounts/:id/refresh` |

用量数据本身由后端通过「一次极小的 Claude Code 请求读 `anthropic-ratelimit-unified-*`
响应头」得到（绕开限流极狠的 `/api/oauth/usage`）。详见 `../main-web/README.md`。

第二个模块「终端」对接 zsh-web Hub 的接口：

| 用途 | 接口 |
|---|---|
| 原生 App 登录（AUTH_TOKEN → 会话令牌） | `POST /api/app/login` |
| 机器（Agent）列表 + 在线状态 | `GET /api/agents` |
| 某机器的会话列表 | `GET /api/agents/:id/sessions` |
| 新建 / 结束会话 | `POST` / `DELETE /api/agents/:id/sessions[/:sid]` |
| 实时终端（双向字节流） | `WS /ws?agent=&session=&access_token=` |

Hub 远程登录原本只有 Synology OAuth2 浏览器跳转，原生 App 不好走 cookie 流程，所以
Hub 新增了 `POST /api/app/login`：用部署时设的 **AUTH_TOKEN** 当凭据换一个会话令牌，
之后 REST 走 `Authorization: Bearer`、WebSocket 走 `?access_token=`。**前提是 Hub 那边
必须设了 `AUTH_TOKEN`**（docker-compose 的 `.env` 里），否则 App 无法登录。

## 功能（当前）

- **用量**：多账号卡片，5 小时 / 每周窗口双进度条，按用量染色（绿 <60% / 橙 60–85% /
  红 ≥85%），重置倒计时，单卡刷新 + 下拉刷新。
- **终端**：机器列表（在线/离线 + 会话数）→ 会话列表（新建 / 左滑结束）→ 原生终端
  （SwiftTerm，自带 esc/tab/ctrl/方向键/F 键 输入条），断线有「重连」横幅。完整交互，
  可在手机上直接敲 shell / Claude Code。
- **设置**：用量(cc-monitor)地址+密码、终端 Hub 地址+AUTH_TOKEN，各带「连接测试」。
  内网填内网地址，外网填 Lucky 反代的 https 域名。
- **液态玻璃（iOS 26）**：悬浮玻璃底栏 + 滚动收缩 + 玻璃卡片。

> **依赖**：终端模块用 [SwiftTerm](https://github.com/migueldeicaza/SwiftTerm) 渲染。
> 固定在 **1.11.2**——1.12.0 起引入了 Metal 渲染器，会要求安装 Metal Toolchain 组件
> （`xcodebuild -downloadComponent MetalToolchain`，且该资源在国内/某些网络拉不到）。
> 1.11.2 是 Metal 前最后一版，API 与新版一致，免掉这个大组件依赖。

## 构建 & 运行

要求：**Xcode 26+，iOS 26 SDK**（液态玻璃 API 需要）。

```bash
open Hub.xcodeproj
```

1. 选中 **Hub** target → *Signing & Capabilities* → **Team 选你自己的开发者账号**
   （bundle id `com.example.hub`，可改）。
2. **真机直装**：手机连电脑，选你的设备 → Run。
3. **TestFlight**：Product → Archive → Distribute → TestFlight；手机用 TestFlight App
   安装，之后改版本推新构建即可（自用首选，无需公开审核）。
4. 首次启动在「设置」里填监控服务器地址 + 密码。

命令行编译验证（模拟器，免签名）：

```bash
xcodebuild -project Hub.xcodeproj -scheme Hub \
  -sdk iphonesimulator -destination 'platform=iOS Simulator,name=iPhone 17' \
  -configuration Debug CODE_SIGNING_ALLOWED=NO build
```

## 工程结构

```
Hub.xcodeproj          # 用 PBXFileSystemSynchronizedRootGroup（文件夹自动同步，无需手动登记每个文件）
Hub/
  HubApp.swift         # @main，注入 AppModel + HubModel，强制深色
  RootView.swift       # TabView（用量 / 终端 / NAS / 下载）+ 玻璃底栏 + 滚动收缩
  UsageView.swift      # 用量页：玻璃卡片 + 进度条
  SettingsView.swift   # cc-monitor 地址+密码、Hub 地址+AUTH_TOKEN，各带连接测试
  AppModel.swift       # @Observable：用量连接、账号、刷新
  APIClient.swift      # cc-monitor 接口客户端（URLSession + 共享 cookie）
  Models.swift         # Account / Usage / UsageWindow（Codable）
  ── 终端模块 ──
  HubModel.swift       # @Observable：Hub 连接设置 + 机器列表（缓存 HubClient）
  HubClient.swift      # Hub REST 客户端（actor，token→Bearer，401 自动重登）
  HubModels.swift      # Machine / TermSession（Codable）
  MachinesView.swift   # 机器列表 → 会话列表（新建/结束）
  TerminalSocket.swift # 终端 WebSocket 传输（二进制字节流 + resize）
  TerminalScreen.swift # SwiftTerm UIViewRepresentable + 连接状态 + 重连横幅
  ──
  Info.plist           # ATS 放开（直连内网 http）、本地网络用途说明
  Assets.xcassets      # AppIcon / AccentColor 占位
```

## 踩坑记录（重要）

- **新 `Tab(_:systemImage:){}` API 会崩**：在 iOS 26.5 上用 iOS 26 的新 `Tab` builder
  写 TabView，App **一启动就崩**（不留崩溃报告，进程秒退）。逐个隔离验证：`.tabItem`、
  `.tabBarMinimizeBehavior(.onScrollDown)`、`.glassEffect(...)`、`GlassEffectContainer`
  单独都正常，**唯独新 `Tab` builder 崩**。→ 用回 `.tabItem`，玻璃底栏照样自动生效。
- **液态玻璃底栏是自动的**：只要用 iOS 26 SDK 编译，普通 `.tabItem` 的 TabView 在
  iOS 26 上就会自动渲染成悬浮玻璃底栏，无需新 API。
- **`Window` 命名冲突**：模型不能叫 `Window`（与 `SwiftUI.Window` 场景类型冲突），
  本项目用 `UsageWindow`。
- **`Info.plist` 重复产物**：用文件夹自动同步时，需在工程里把 `Info.plist` 从 target
  成员里排除（`PBXFileSystemSynchronizedBuildFileExceptionSet`），否则报
  "Multiple commands produce Info.plist"。
- **ATS**：直连内网 `http://` 需 `NSAppTransportSecurity → NSAllowsArbitraryLoads`
  （已在 Info.plist 配好）。
- **诊断 App 崩没崩**：`xcrun simctl spawn <udid> launchctl list | grep hub` —— 进程在
  = 活着，没了 = 崩了。比截图判断可靠。

## 路线图

- [ ] **推送提醒**（用量超阈值推到手机，替代邮件）——需配 APNs
- [ ] **桌面 / 锁屏小组件**（一眼看用量）
- [ ] 密码改存 **Keychain**（当前在 UserDefaults）
- [ ] **NAS / 下载** 模块（如 qBittorrent 控制、NAS 状态）
- [ ] App 图标
