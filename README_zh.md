<p align="center">
  <img src="assets/nanoclaw-logo.png" alt="NanoClaw" width="400">
</p>

<p align="center">
  个人 WhatsApp AI 助手，在容器中安全运行 —— 已改造为支持 OpenRouter 或本地 Ollama 的任意模型，并新增本地语音输入/输出。
</p>

---

> **本项目 Fork 自 [qwibitai/nanoclaw](https://github.com/qwibitai/nanoclaw)**，原作者 [@gavrielc](https://github.com/gavrielc)。
> 本 Fork 将 `@anthropic-ai/claude-agent-sdk` 替换为基于 OpenAI 兼容接口的智能体循环，
> 新增本地语音转写与语音合成，并接入 Gemini CLI 处理复杂编码任务 ——
> 全程无需任何付费 API。

---

## 与上游的主要差异

|  | 上游 NanoClaw | 本 Fork |
|---|---|---|
| **模型** | Claude（需要 Anthropic 订阅或 API Key） | 任意 OpenRouter 模型或本地 Ollama |
| **智能体 SDK** | `@anthropic-ai/claude-agent-sdk` | 标准 `openai` 包（OpenAI 兼容接口） |
| **Docker 镜像大小** | ~1.5GB（含 Chromium + claude-code） | ~400MB（仅 Node + ripgrep） |
| **费用** | 需要付费 Anthropic 访问权限 | OpenRouter 免费套餐，或完全本地运行 |
| **语音消息接收** | 不支持 | ✅ 本地 Whisper（ASR）自动转写 |
| **语音消息回复** | 不支持 | ✅ 本地 Piper TTS 语音合成回复 |
| **重度编码任务** | claude-code CLI | ✅ Gemini CLI（Gemini 2.5 Pro，免费） |

## 快速开始

```bash
git clone https://github.com/kazGuido/stingyclaw.git
cd stingyclaw
cp .env.example .env
# 编辑 .env，填入您的 OPENROUTER_API_KEY 和 MODEL_NAME
```

然后按顺序执行安装步骤：

```bash
bash setup.sh                                                    # 检查 Node + 依赖
npx tsx setup/index.ts --step container -- --runtime docker      # 构建智能体镜像
docker compose up -d voice                                       # 启动本地语音服务
npx tsx setup/index.ts --step whatsapp-auth -- --method pairing-code --phone +8613800138000
npx tsx setup/index.ts --step service                            # 安装并启动 systemd 服务
```

## 模型配置（`.env`）

```bash
# OpenRouter（openrouter.ai 提供免费模型）
OPENROUTER_API_KEY=sk-or-v1-...
MODEL_NAME=stepfun/step-3.5-flash:free   # 速度快，工具调用效果好，有免费套餐
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1

# 本地 Ollama（完全离线运行）
# OPENROUTER_API_KEY=ollama
# MODEL_NAME=llama3.2
# OPENROUTER_BASE_URL=http://host.docker.internal:11434/v1

# 可选：Gemini CLI，用于复杂编码任务（在 aistudio.google.com 免费申请）
# GEMINI_API_KEY=AIza...
```

推荐的免费 OpenRouter 模型：
- `stepfun/step-3.5-flash:free` —— 速度快，工具调用能力强，免费套餐慷慨
- `liquid/lfm-2.5` —— Liquid AI 自家模型
- `google/gemini-flash-1.5` —— 免费套餐，能力全面
- `mistralai/mistral-7b-instruct:free` —— 轻量级，免费

## 功能支持

- **WhatsApp 输入/输出** —— 通过手机给助手发消息
- **语音消息** —— 发语音给助手，自动转写后响应；助手也可以用语音消息回复
- **隔离的群组上下文** —— 每个群组都有独立的 `CLAUDE.md` 记忆、文件系统和容器沙箱
- **计划任务** —— 周期性作业，运行完成后主动给您发消息
- **网络访问** —— 抓取和读取 URL 内容
- **容器隔离** —— 智能体在 Docker 中运行，只能访问明确挂载的目录
- **Gemini CLI** —— 将复杂编码任务委托给 Gemini 2.5 Pro
- **工具集** —— Bash、读写文件、Grep、Glob、WebFetch、send_message、send_voice、schedule_task

## 架构

```
WhatsApp (baileys)
    ↓ 收到语音消息？
语音服务（Docker）← faster-whisper（Whisper-small，纯 CPU）
    ↓ [Voice: 转写文本]
SQLite → 轮询循环 → 智能体容器（OpenRouter 循环）
    ↓ send_voice IPC
语音服务 → Piper TTS → OGG → WhatsApp PTT 语音回复
```

单一 Node.js 宿主进程。智能体在每条消息的独立 Docker 容器中执行。
语音服务是独立的持久化 Docker 容器（通过 `docker compose up -d voice` 启动）。

关键文件：
- `src/index.ts` —— 编排器：状态管理、消息循环、智能体调用
- `src/channels/whatsapp.ts` —— WhatsApp 连接，文本与语音消息收发
- `src/transcription.ts` —— ASR + TTS 客户端（调用语音服务 HTTP API）
- `src/ipc.ts` —— IPC 监听：文本消息、语音消息、任务调度
- `src/container-runner.ts` —— 生成智能体容器，通过 stdin 传递密钥
- `src/task-scheduler.ts` —— 运行计划任务
- `container/agent-runner/src/index.ts` —— **智能体循环**（OpenAI 兼容，支持 OpenRouter/Ollama）
- `container/voice-service/` —— FastAPI 服务：`/transcribe`（Whisper）+ `/synthesize`（Piper）
- `docker-compose.yml` —— 管理语音服务容器
- `groups/*/CLAUDE.md` —— 各群组的记忆文件

## 系统要求

- Linux（或 macOS）
- Node.js 22+
- Docker + Docker Compose
- OpenRouter API Key（在 [openrouter.ai](https://openrouter.ai) 免费注册）—— 或本地安装的 Ollama

## 从上游同步更新

```bash
git fetch upstream
git merge upstream/main
# 主要冲突点：container/agent-runner/src/index.ts 和 src/channels/whatsapp.ts
docker build -t nanoclaw-agent:latest -f container/Dockerfile container/
docker compose build voice  # 如果 Dockerfile 有变更，同步重建语音服务
```

## 致谢

本 Fork 基于 [NanoClaw](https://github.com/qwibitai/nanoclaw)（qwibitai 出品），采用 MIT 许可证。
原始架构、WhatsApp 集成、IPC 设计和容器隔离模型的全部功劳归属于上游作者。

## 许可证

MIT
