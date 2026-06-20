# zsh-web

> 浏览器里的多机、多会话共享终端。在一个网页里选「机器 → 会话」开终端,任意设备连同一会话**字节级同步**。

一个轻量的自托管终端中枢:**Hub** 跑在你的服务器/NAS 上(只负责网页、登录、字节中继,自己不开 shell),每台电脑跑一个 **Agent** 主动拨号上 Hub、注册自己,并按需在本机开 zsh。手机、平板、另一台电脑都能连进同一个会话,看到完全一致的画面。

**特性**

- 🖥️ **多机多会话**:一个网页管理所有机器上的所有 zsh 会话。
- 🔄 **字节级同步**:多端连同一会话,输入输出实时一致;新接入即见当前屏(滚屏缓存)。
- 🔌 **NAT 友好**:Agent 主动出站拨号,只需 Hub 可达,无需给每台机器开端口。
- 💾 **会话持久化**:Agent 重启自动恢复会话列表与历史(shell 是新进程)。
- 🔐 **两层鉴权**:浏览器走 OIDC 单点登录(如 Synology),机器走一次性配对得来的专属 token。
- 📱 **iOS App**:`ios-hub/` 下有一个原生 SwiftUI 客户端(基于 SwiftTerm)。

---

## 架构(Hub + Agent)

```
        浏览器(任意设备)──WSS + OIDC 登录──▶  Hub (服务器/NAS, Docker)
                                                │  网页 + 鉴权 + 机器注册表 + 字节中继
                            Agent 主动拨号 ▲     │  (自己不开 shell)
                ┌───────────────┬──────────────┘
                ▼               ▼
            Agent(Mac)     Agent(台式机) …   各自开本机 zsh PTY,桥接给 Hub
```

- **Hub**(`hub.js`):服务网页、OIDC 登录、机器注册/配对、在浏览器与目标机器之间来回中继字节;为每个会话缓存滚屏(`SCROLLBACK` 字节),新浏览器接入即见当前屏。不依赖 node-pty(不开 PTY),容器镜像是纯 JS、无原生编译。
- **Agent**(`agent.js`):每台电脑一个常驻进程,拨号 `wss://<hub>/agent`(NAT 友好,只需 Hub 可达),持有本机会话,经一条 WS 多路复用所有会话。断线指数退避重连,收到 SIGTERM 优雅刷盘。
- **会话内核**(`sessions.js`):每会话 = 一个独立 zsh PTY,replay 缓冲节流落盘到 `SESSION_DIR`(默认各机 `./.sessions/`)。Agent 重启后自动恢复会话列表 + 历史,但 shell 是新进程(`cd`、后台任务、环境变量不保留),历史末尾插一行「服务已重启」。主动 `exit` 或被删的会话,存档随即删除。
  > ⚠️ 落盘的是终端原始输出(可能含命令/敏感信息),明文存于各机 `SESSION_DIR`。

**多路复用协议**(`wire.js`,一条 Agent↔Hub WS 承载多会话)

- 控制帧 = JSON 文本:`{t:"create|created|kill|resize|exit|sessions", sid?, ...}`
- 数据帧 = 二进制:`[8 字节 sid][PTY 原始字节]`(会话 id 恒为 8 hex,定长前缀)

**浏览器协议**(`/ws?agent=<机器id>&session=<会话id>`)

- shell 输出 → 浏览器:二进制帧喂 xterm.js;键盘 → shell:二进制帧
- 改窗口大小:JSON `{"type":"resize","cols":..,"rows":..}`

---

## 快速开始

### 1. 部署 Hub(Docker)

```bash
cp .env.example .env      # 填入 AUTH_SECRET / OAUTH2_* 等(见下表)
docker compose up -d --build
```

`docker-compose.yml` 起两个容器(同一镜像):

- **hub** → 发布 `7654`(用你的反代指到这里),挂载 `./data` 存机器注册表。
- **usage** → 内部 `7655`,Claude 用量监控服务,仅 hub 经 compose 网络访问(不对外发布端口)。可选。

**反向代理**:把一个子域名整根转发到 Hub 的 `7654`,**务必开启 WebSocket 透传**并签 TLS。前端用 `/ws`、`/api` 绝对路径,所以**不能放在子路径下**,必须独立子域名整根转发。

**OIDC 登录**(以 Synology SSO 为例):在身份提供方创建应用,把三个端点和 Redirect URI 填进 `.env`;**Redirect URI 必须逐字一致**,scope 视提供方而定(Synology 仅支持 `openid email`,无 `profile`)。

### 2. 注册一台新电脑(网页配对码)

```bash
# ① 网页(已登录)点「+ 添加」→ 弹出一次性配对码(默认 5 分钟有效)
# ② 新电脑上(已 npm install)跑一次:
HUB_URL=http://<your-hub-host>:7654 node agent.js pair <配对码> --name 工作站
#    Agent 用码换「本机专属长期凭据」,存到 ~/.zshweb-agent.json
# ③ 之后 `node agent.js` 即自动上线(配开机自启,见下)
```

- 配对码:Hub 内存里,一次性消费 + TTL,只有已登录用户能生成。
- 机器凭据:Hub 每机一个随机 token,**只存哈希**;吊销 = 删注册表记录,该机被踢下线。
- 注册表 `data/machines.json`,挂载卷持久化,容器重建不丢。

### 3. Mac 上 Agent 开机自启(launchd)

```bash
# 先配对一次,凭据落到 ~/.zshweb-agent.json,然后:
cp com.zshweb.agent.plist ~/Library/LaunchAgents/
launchctl load   ~/Library/LaunchAgents/com.zshweb.agent.plist   # 启动并自启
launchctl unload ~/Library/LaunchAgents/com.zshweb.agent.plist   # 停止
# 改 agent.js / plist 后:先 unload 再 load
```

> 编辑 `com.zshweb.agent.plist`,把 `HUB_URL`、`MACHINE_NAME`、`SESSION_DIR`、`WorkingDirectory`、各路径改成你自己的。
> **macOS 完全磁盘访问**:Agent 会 `cd` 到桌面/文稿等目录,需给 node 二进制(如 `/opt/homebrew/bin/node`)开「完全磁盘访问权限」,否则反复弹「node 想访问数据」。node 升级后真实路径变,需重加。

---

## 环境变量

| 变量 | 用于 | 说明 |
|------|------|------|
| `PORT` / `HOST` | Hub/Agent | Hub 监听(默认 `7654` / `0.0.0.0`) |
| `AUTH_SECRET` | Hub | cookie 签名密钥;**固定**以保持重启后登录态 |
| `AUTH_TOKEN` | Hub | 本机命令行 token 登录(可选;OAuth2 为主) |
| `OAUTH2_*` | Hub | OIDC 应用凭据 + 三端点 + Redirect URI + scope |
| `DATA_DIR` | Hub | 机器注册表目录(容器内 `/app/data`,挂载卷) |
| `SCROLLBACK` | Hub/会话 | 每会话 replay 缓冲字节数 |
| `USAGE_API_URL` | Hub | 用量服务地址(compose 内 `http://usage:7655`) |
| `CC_PROXY` | usage | 访问 Anthropic 的出站代理(可选),如 `http://user:pass@host:port` |
| `POLL_INTERVAL_MS` | usage | 用量轮询间隔毫秒(默认 5 分钟) |
| `HUB_URL` | Agent | Hub 地址(如 `http://<your-hub-host>:7654`) |
| `MACHINE_NAME` | Agent | 机器显示名(默认主机名) |
| `SESSION_DIR` / `PERSIST_MS` | Agent/会话 | 历史落盘目录 / 写盘节流毫秒(默认 2000) |
| `AGENT_STORE` | Agent | 凭据文件(默认 `~/.zshweb-agent.json`) |

---

## REST / WS 一览

| 方法 | 路径 | 作用 |
|------|------|------|
| POST | `/api/pair/new` | (登录态)生成一次性配对码 |
| POST | `/agent/pair` | (无浏览器鉴权)Agent 用码换专属 token |
| GET/DELETE | `/api/agents` `/api/agents/:id` | 列出 / 吊销机器 |
| GET/POST | `/api/agents/:id/sessions` | 列出 / 新建该机器上的会话 |
| DELETE | `/api/agents/:id/sessions/:sid` | 杀会话 |
| GET | `/api/me` `/api/usage` | 当前用户 / 用量(转发 usage 服务) |
| WS | `/agent?token=&machine=` | Agent 拨号入口(机器 token 鉴权) |
| WS | `/ws?agent=&session=` | 浏览器接入某机器的某会话(需登录) |

---

## 故障排查

- **网页「重连中…」**:反代的 WebSocket 没透传 → 检查该规则的 WebSocket 开关。
- **机器一直离线**:Agent 连不上 Hub → 查 `HUB_URL` 可达、凭据未被吊销;看 `zsh-web-agent.log`。
- **新建会话失败/机器离线**:该机 Agent 没在跑或刚断线(Hub 等 Agent 回执超时)。
- **用量 502**:usage 容器没起来或配置缺失 → `docker compose ps` / 看日志。
- **OIDC 登录卡 callback**:多半是 Redirect URI 不一致或 client secret 不对。
- **又弹「node 想访问数据」**:node 升级导致完全磁盘访问失效,重加 node。

---

## 目录结构

```
hub.js            Hub:网页 + 鉴权 + 机器注册 + 字节中继
agent.js          Agent:每台机器一个常驻进程,拨号上 Hub
sessions.js       会话内核:每会话一个 zsh PTY + 持久化
wire.js           Agent↔Hub 多路复用线协议
auth.js           OIDC / token 登录
usage/            Claude 用量监控服务(可选)
public/           前端(xterm.js)
ios-hub/          iOS 原生客户端(SwiftUI + SwiftTerm)
server.js         遗留单机模式(网页 + 本机 PTY 同进程,待退役)
client.js         遗留单机模式的本地终端观看者
```

> **遗留单机模式**:`server.js` / `client.js` 是 Hub+Agent 方案之前的单机版(网页和 shell 同机),保留作参考,可按需删除。

---

## License

MIT
