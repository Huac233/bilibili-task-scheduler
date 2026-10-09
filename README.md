# 直播定时任务

在服务器上挂着，监测直播间开播后循环发送弹幕，也替账号做每天的签到这类动作。B 站和斗鱼都靠扫码绑定账号，之后不用开浏览器——区别在续期靠什么：B 站靠 refresh token，斗鱼靠网页会话里的 `LTP0` 重建令牌家族。所以斗鱼的凭据里没有 `LTP0`（粘贴进来的那种），或者服务端不再认它时，才要重新扫码绑定。

不需要开着直播页面，也不需要油猴脚本。

## 功能

- 多用户注册登录，各自管理账号和任务
- 两个平台：B 站和斗鱼。账号各自扫码绑定（斗鱼的扫码会顺带存下网页会话），斗鱼另有粘贴凭据的备用入口
- B 站登录态自动续期；斗鱼同样自动续期（用网页会话里的 `LTP0` 重建令牌家族），凭据里没有 `LTP0` 时才需要重新扫码绑定
- 每个动作一个开关，默认关；会消耗账号资产的动作在开关上标出来，开启时要再确认一次
- B 站日常动作：点赞、观看直播；斗鱼日常动作：客户端签到、看广告鱼丸、鱼吧签到、任务中心签到、粉丝家园签到、打卡分鱼丸（报名一次扣 200 鱼丸）
- 整本小说导入，按标点或长度切分成弹幕
- 分割参数可调，导入前实时预览
- 开播监测（B 站的轮播不算开播），下播自动暂停
- 加盐发送，每条随机插入 2 个标点
- 任务可暂停后编辑生效时间、间隔、加盐等参数
- 进度显示已发送量和当前遍数
- 任务详情页：今天的动作明细逐条列出，历史按天折叠，另有高级/调试区块和发送日志
- 事件流 API，可接通知机器人

## 部署

需要 Docker。

```bash
git clone https://github.com/Huac233/bilibili-task-scheduler.git
cd bilibili-task-scheduler
docker build -t bilibili-task-scheduler:latest .
```

生成密钥，填进 `docker-compose.yml`：

```bash
openssl rand -hex 32
```

启动：

```bash
docker compose up -d
```

打开 `http://localhost:8787`。

### 1Panel

推荐在本地构建后传输，服务器上不用装编译环境：

```bash
docker build -t bilibili-task-scheduler:latest .
docker save bilibili-task-scheduler:latest | gzip > bts.tar.gz
scp bts.tar.gz root@服务器:/root/
```

服务器上：

```bash
docker load < bts.tar.gz
```

然后在 1Panel 的 **容器 → 编排** 里创建，内容用仓库里的 `docker-compose.yml`，但把 `build: .` 换成：

```yaml
image: bilibili-task-scheduler:latest
```

对外访问走 **网站 → 反向代理**，目标 `127.0.0.1:8787`，SSL 让 1Panel 签。

### 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | 8787 | 监听端口 |
| `HOST` | 0.0.0.0 | 监听地址 |
| `DB_PATH` | data/app.sqlite | 数据库路径 |
| `SESSION_SECRET` | 随机 | 会话密钥，**部署时必填** |
| `LOG_REQUESTS` | 未设置 | 设为 `1` 打开请求日志 |

`SESSION_SECRET` 不填会每次重启随机生成，所有人被踢下线。

## 使用

1. 注册账号（系统自己的，跟直播平台无关）
2. **账号** → 选平台，扫码绑定
3. **动作开关** → 打开要跑的动作；没打开的动作不会被任何任务执行，用没打开的动作创建任务会被直接拒绝
4. **文本库** → 导入文本，调整分割参数后预览确认
5. **任务** → 创建，选平台、账号和动作，粘贴直播间链接，设时间窗和间隔
6. 任务详情页看进度、动作明细和发送日志

导入小说前建议先删掉版权页和目录，它们会被当成正文发出去。

## 外部集成

外部程序可以读取事件流，用来推送通知。

在「**外部集成**」页面创建 API 令牌，然后：

```bash
curl -H "Authorization: Bearer bts_xxx" \
  "https://你的地址/api/events?since=0"
```

返回：

```json
{
  "events": [
    {
      "id": 12,
      "kind": "task_went_live",
      "severity": "info",
      "title": "直播间开播，开始发送",
      "detail": "某直播间",
      "platform": "bilibili",
      "taskId": 3,
      "accountId": 1,
      "createdAt": 1791263075319
    }
  ],
  "nextCursor": 12,
  "latestId": 12,
  "hasMore": false
}
```

下次请求把 `nextCursor` 传回 `since`。事件按 id 升序返回，不会跳号。

**事件类型**：

| kind | 说明 |
|---|---|
| `task_went_live` | 检测到开播 |
| `task_finished` | 发送窗口结束 |
| `task_failed` | 任务因不可恢复的错误停止 |
| `action_failed` | 日常动作失败，本轮其余动作照常继续 |
| `action_blocked` | 日常动作被平台拒绝、因此停到明天（余额不足、账号没有网页会话等） |
| `session_expired` | 登录失效或续期失败 |
| `account_restricted` | 只有 B 站的 `-403` 会写它：账号级封禁，重新绑定不会解除（房间禁言走 `action_blocked`） |
| `other` | 服务端读到它不认识的 kind 时用它回答，消费方必须处理 |
| `task_started` | 只声明，本版本不会发出 |
| `task_sending_trouble` | 只声明，本版本不会发出 |
| `session_refreshed` | 只声明，本版本不会发出 |

日常动作（B 站的点赞、观看直播；斗鱼的客户端签到、看广告鱼丸、鱼吧签到、任务中心签到、粉丝家园签到、打卡分鱼丸）没有弹幕那样的 Bullet 可记，它们的每一次结果只落在任务详情页的动作日志里；`action_failed` 与 `action_blocked` 就是把它们接到事件流上的两个类型，否则通知机器人看不见这类失败。

同一任务的同类事件在 30 分钟内有抑制窗口，不会重复推送；没有任务上下文的（例如账号自动续期失败）按用户整体抑制。事件还带 `platform` 字段，多平台绑定同一个用户时用它区分。读到不认识的 `kind`，服务端会用 `other` 回话，不会把它猜成别的类型——所以消费方必须处理 `other` 并留一个默认分支：以后服务端加类型，事件不会丢，只是要等消费方认识它才有显示名。

**其他接口**：

| 接口 | 说明 |
|---|---|
| `GET /api/platforms` | 列出平台、每个平台的动作目录和动作说明；界面据此渲染，不写死平台 |
| `GET /api/events?since=&limit=` | 增量拉取 |
| `GET /api/events/recent?limit=&kinds=` | 最近事件，倒序；`kinds` 逗号分隔，只要这些种类，缺省为全部 |
| `GET /api/tokens` | 列出令牌（不含明文） |
| `POST /api/tokens` | 创建，明文只返回一次 |
| `DELETE /api/tokens/:id` | 吊销，立即生效 |

AstrBot 通知插件是 `astrbot_plugin_bilibili_notify`：装在 AstrBot 的 `data/plugins/` 下，订阅的就是这里的 `GET /api/events`，平台名取自 `GET /api/platforms`。

「外部集成」页上的事件流可以只显示你勾选的种类，**那只影响这一页**：`kinds` 只加在 `GET /api/events/recent` 上，而插件读的是 `GET /api/events`，它的游标与投递不受影响。

## 开发

```bash
pnpm install
pnpm dev:server      # 后端 8787
pnpm dev:web         # 前端 5173，已配代理

pnpm check           # lint + 类型 + 测试
pnpm lint:fix        # 自动修格式
```

代码规范用 [Biome](https://biomejs.dev/)，两条硬规则：禁用 `any`，禁用非空断言 `!`。

## 注意事项

**弹幕长度**：上限来自你选的那个动作（`ActionDescriptor.maxMessageLength`），不是全局常量。B 站普通账号 20 字（大航海 30 字，项目按 20 保守声明），超长会被拒收；斗鱼 70 字，超长**不报错**——服务端只广播前 70 个字，是静默截断，不是拒收。

**发送间隔**：下限同样来自动作——B 站发弹幕最低 10 秒（默认 30 秒），斗鱼最低 3 秒（默认 3 秒），各类每日动作最低 60 秒（默认 300 秒）。实际建议比下限更慢，更容易过风控。

**轮播不算开播**（B 站）。B 站 `live_status` 为 2 是回放录像，适配器把它归一成「未开播」；斗鱼用自己的 `show_status`，只有 1 算开播，其余都归一成未开播。

**版权页会被切进去**。导入前手动删掉。

**登录态**：B 站绑定时保存 refresh token，自动续期；续期失败要重新扫码绑定，事件流里会给一条「登录已失效」。斗鱼也用网页会话里的 `LTP0` 自动重建令牌家族（`acf_*`）：凭据里没有 `LTP0`、而家族又到了该续期的时候，它给出同一条「登录已失效」。续期只是一次没成功（比如两跳里有一跳没到）不算——凭据没被改写，下一个 6 小时的检查会重试，这种失败只进服务端日志，不进事件流。凭据真的不被服务端认可时，由发送或日常动作按账号级错误把任务停下来，给出同一条「登录已失效」，解决方式同样是重新扫码绑定。

**这是民间自用工具**，自动化发送属于对平台的非常规使用。请控制频率，不要打扰主播和其他观众。

## 技术栈

后端 Node 24+ / TypeScript / Fastify 5 / SQLite（`node:sqlite`，无原生依赖）
前端 Vue 3 / TypeScript / Vite / Naive UI
部署 单容器，单数据卷

## 许可证

AGPL-3.0 —— 正文见 [LICENSE.md](./LICENSE.md)。

参考了 [bakapiano/bilibili-task-scheduler-backend](https://github.com/bakapiano/bilibili-task-scheduler-backend) 的任务字段设计；它那个「每个用户最多 10 个任务」的上限没有沿用（任务数现在没有上限，理由写在 `server/src/routes/tasks.ts` 里那段「There is no cap」上面），发送间隔下限和任务时长上限也没有沿用它的值，是有意改掉的。另有 [aijc123/bilibili-live-wheel-auto-follow](https://github.com/aijc123/bilibili-live-wheel-auto-follow) 的 WBI 签名实现思路。

---

本项目由 **DeepSeek V4.1 Flash** 开发。
