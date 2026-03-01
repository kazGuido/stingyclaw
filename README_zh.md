<p align="center">
  <img src="assets/stingyclaw-logo.png" alt="Stingyclaw" width="600">
</p>

<p align="center">
  <strong>你的专属 WhatsApp AI —— 免费模型、真实语音、真实自动化。</strong><br>
  因为好用的 AI 不该需要公司信用卡。
</p>

---

## 故事起源

[NanoClaw](https://github.com/qwibitai/nanoclaw) 是个精妙的小项目：一个住在 WhatsApp 里的 AI 助手，在 Docker 容器中运行，用 Claude 来做推理。问题在哪？Claude 要钱。真金白银的钱。而且它用的是 Anthropic 的专有 SDK，把你死死锁在他们的生态里。

**Stingyclaw** 是穷开发者的 Fork。

目标很简单：把所有需要付费订阅的东西全部拆掉，换成*真正好用*的免费替代品，再加上我们真正想要的功能——语音消息收发、能处理真实网页的浏览器、以及一种无需每次都写新工具就能定义自定义自动化的方式。

最终成果：一个运行在免费 Gemini API 额度上的 WhatsApp 助手，能在本地说话和聆听，像真正的浏览器一样上网，还能按命令执行你自己写的 shell 脚本——全程通过手机，全程容器隔离，完全属于你。

项目名字？Stingyclaw 取自"stingy"（吝啬）。我们把爪子改造成了会抠门省钱的版本。

---

## 与上游的主要差异

|  | 上游 NanoClaw | Stingyclaw |
|---|---|---|
| **模型** | 仅支持 Claude（需要 Anthropic 订阅） | 任意模型：Gemini、OpenRouter、Ollama |
| **智能体循环** | Anthropic 专有 SDK | 标准 `openai` 包（OpenAI 兼容接口） |
| **Docker 镜像大小** | ~1.5GB | ~2GB（含 Chromium 浏览器自动化） |
| **费用** | 需要付费 Anthropic 权限 | Gemini/OpenRouter 免费套餐，或完全本地运行 |
| **语音输入** | 不支持 | ✅ 本地 Whisper ASR |
| **语音输出** | 不支持 | ✅ 本地 Qwen3-TTS（自然 LLM 语音合成） |
| **浏览器** | 不支持 | ✅ `agent-browser`（Playwright/Chromium，支持 JS） |
| **工作流** | 不支持 | ✅ 语义注册表——shell 脚本即自动化 |
| **记忆文件** | `CLAUDE.md` | `MISSION.md`（模型无关） |

---

## 快速开始

```bash
git clone https://github.com/kazGuido/stingyclaw.git
cd stingyclaw
cp .env.example .env
# 编辑 .env，填入 GEMINI_API_KEY（或 OPENROUTER_API_KEY）
```

按顺序执行安装步骤：

```bash
bash setup.sh                                                                  # 检查 Node + 依赖
npx tsx setup/index.ts --step container -- --runtime docker                    # 构建智能体镜像
docker compose up -d voice                                                     # 启动语音服务
npx tsx setup/index.ts --step whatsapp-auth -- --method pairing-code --phone +8613800138000
npx tsx setup/index.ts --step service                                          # 安装 systemd 服务
```

---

## 模型配置（`.env`）

Stingyclaw 根据已设置的密钥自动检测后端。`GEMINI_API_KEY` 优先级最高。

```bash
# 方案一：Gemini 直连（推荐——免费、快速、工具调用能力强）
GEMINI_API_KEY=AIza...          # 在 aistudio.google.com 免费申请
# MODEL_NAME=gemini-2.5-flash  # 默认
# MODEL_NAME=gemini-2.5-pro    # 推理更强，免费额度较低

# 方案二：OpenRouter（接入 100+ 模型）
# OPENROUTER_API_KEY=sk-or-v1-...
# MODEL_NAME=liquid/lfm-2.5         # 速度快，免费
# MODEL_NAME=meta-llama/llama-3.3-70b-instruct:free

# 方案三：本地 Ollama（完全离线运行）
# OPENROUTER_API_KEY=ollama
# MODEL_NAME=llama3.2
# OPENROUTER_BASE_URL=http://host.docker.internal:11434/v1
```

---

## 工作原理

当你发送 WhatsApp 消息（或语音消息）时，发生的事情如下：

1. **语音消息？** → 由本地 Whisper 转写（无云端，无费用）
2. **文字落入 SQLite** → 宿主轮询循环拾取
3. **为该群组生成一个 Docker 容器** —— 隔离、短暂
4. **智能体循环启动** —— 模型选择工具，执行，循环直到完成
5. **回复发出** —— 文字或语音（Qwen3-TTS 在本地渲染自然语音）
6. **容器退出** —— 会话被保存，下次继续

每个群组完全隔离：独立容器、独立文件系统、独立 `MISSION.md` 人设、独立工作流脚本。

```
WhatsApp 消息
    ↓ 是语音消息？
语音服务（Docker）← Whisper-small ASR（纯 CPU）
    ↓ [Voice: 转写文本]
SQLite → 宿主轮询循环
    ↓
智能体容器（Docker，按群组隔离）
    ├── 主模型（Gemini / OpenRouter / Ollama）
    ├── 内置工具：Bash、Read、Write、Edit、Grep、Glob、
    │            WebFetch、agent-browser、send_message、
    │            send_voice、ask_boss、schedule_task、
    │            list_workflows、search_tools、run_workflow
    └── 工作流注册表（groups/*/workflows/registry.json）
    ↓ send_voice IPC
语音服务 → Qwen3-TTS → OGG → WhatsApp PTT 语音回复
```

单一 Node.js 宿主进程。每条消息生成一个独立 Docker 容器。容器在对话空闲后退出，会话被持久化并在下次恢复。

---

## 智能体能力

### 内置工具（始终可用）

| 工具 | 功能 |
|------|------|
| `Bash` | 在群组沙箱中执行任意 shell 命令 |
| `Read` / `Write` / `Edit` | 在 `/workspace/group/` 中进行文件操作 |
| `Grep` / `Glob` | 搜索文件 |
| `WebFetch` | 抓取静态页面（快速，无额外开销） |
| `agent-browser` | 通过 Bash 调用完整无头浏览器——支持 JS 页面、点击、填写、截图 |
| `send_message` | 在任务中途发送 WhatsApp 文字（进度更新） |
| `send_voice` | 发送 WhatsApp 语音消息（Qwen3-TTS） |
| `ask_boss` | 在执行危险操作前向用户请求指引 |
| `schedule_task` | 安排周期性或一次性智能体任务 |
| `list_workflows` | 列出所有已注册的自动化脚本 |
| `search_tools` | 对工作流注册表进行语义搜索 |
| `run_workflow` | 按名称执行一个工作流 |

### 网页浏览

- **静态页面**：`WebFetch` —— 速度快，无额外开销
- **JS 渲染页面、登录流程、交互式网站**：`agent-browser`（Playwright/Chromium）
  ```bash
  agent-browser open <url>
  agent-browser snapshot -i        # 可访问性树（含引用 @e1、@e2...）
  agent-browser click @e1
  agent-browser fill @e2 "文字"
  agent-browser screenshot page.png
  ```

### 工作流注册表——你的个人自动化库

这是 Stingyclaw 真正有趣的地方。与其把所有能力都硬编码进智能体，不如把 shell 脚本丢进 `groups/*/workflows/`，在 `registry.json` 里登记一下。智能体通过**语义搜索**自动发现它们——无需关键词，无需精确匹配，只看意图。

```
groups/main/
  workflows/
    registry.json      ← 索引，含名称与描述
    morning-briefing.sh
    notify-slack.sh
    pull-crm.sh
```

**`registry.json` 格式：**
```json
[
  {
    "name": "morning-briefing",
    "description": "每日天气与新闻摘要。也可用于：早报、日报、早间简报。",
    "run": "bash morning-briefing.sh"
  },
  {
    "name": "notify-slack",
    "description": "向 Slack 频道发送消息",
    "run": "bash notify-slack.sh",
    "args": ["message", "channel"]
  }
]
```

脚本可以是 bash、Python、Node——任何可执行的东西。参数通过环境变量传入。嵌入向量在本地计算（`all-MiniLM-L6-v2`，已内置到镜像中），并缓存在 `.embeddings-cache.json`。

**智能体的决策流程：**
```
用户："早报"
  → search_tools("早报")  [语义匹配 → 命中]
  → run_workflow("morning-briefing")
  → bash morning-briefing.sh
  → 回复

用户："法国的首都是哪里？"
  → search_tools("法国首都")  [无匹配]
  → 模型直接回答
```

智能体的系统提示里永远不会塞满工作流详情。它在需要的时候才查找，就像人一样。

### 每群组记忆（`MISSION.md`）

每个群组都有一个 `groups/{name}/MISSION.md`，在每次请求时注入系统提示。这是你给该群组的智能体赋予人设、上下文和常驻指令的地方。保持简短——它每次请求都会发送。对于较大的参考数据，让智能体按需 `Read` 文件即可。

---

## 关键文件

| 文件 | 用途 |
|------|------|
| `src/index.ts` | 编排器：消息循环、智能体调用 |
| `src/channels/whatsapp.ts` | WhatsApp 连接，文字与语音收发 |
| `src/container-runner.ts` | 生成智能体容器，通过 stdin 传递密钥 |
| `src/ipc.ts` | IPC 监听：消息、语音、任务 |
| `src/task-scheduler.ts` | 计划任务运行器 |
| `src/transcription.ts` | ASR + TTS HTTP 客户端 |
| `container/agent-runner/src/index.ts` | **智能体循环** —— 所有工具、会话管理 |
| `container/Dockerfile` | 智能体镜像（Node + ripgrep + agent-browser + 嵌入模型） |
| `container/voice-service/` | FastAPI 服务：`/transcribe`（Whisper）+ `/synthesize`（Qwen3-TTS） |
| `docker-compose.yml` | 语音服务容器 |
| `groups/*/MISSION.md` | 每群组人设与记忆 |
| `groups/*/workflows/registry.json` | 每群组工作流注册表 |

---

## 路线图 / 接下来要做什么

当前版本是一个扎实的基础。接下来：

- **MCP 客户端** —— 接入任意 MCP 服务器（Gmail、GitHub、Slack），无需改代码即可动态加载工具
- **更丰富的工作流参数** —— 类型化输入、校验、运行前提示缺失参数
- **n8n / Webhook 桥接** —— 从注册表脚本调用外部自动化平台
- **群组引导** —— 新群组首次消息时自动询问其任务/上下文
- **每群组智能体自定义** —— 群组可修改自己的 agent-runner 源码（已挂载为可写）
- **记忆嵌入** —— 对话历史的语义搜索，不仅限于工作流

---

## 系统要求

- Linux（或 macOS）
- Node.js 22+
- Docker + Docker Compose
- Gemini API Key（在 [aistudio.google.com](https://aistudio.google.com) 免费申请）—— 或 OpenRouter/Ollama

---

## 从上游同步更新

```bash
git fetch upstream
git merge upstream/main
# 主要冲突点：container/agent-runner/src/index.ts 和 src/channels/whatsapp.ts
docker build -t nanoclaw-agent:latest -f container/Dockerfile container/
docker compose build voice
```

---

## 致谢

本 Fork 基于 [NanoClaw](https://github.com/qwibitai/nanoclaw)（qwibitai 出品），采用 MIT 许可证。
原始架构、WhatsApp 集成、IPC 设计和容器隔离模型的全部功劳归属于上游作者。

## 许可证

MIT
