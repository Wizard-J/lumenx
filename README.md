<!-- Banner Placeholder -->
<div align="center">
  <img src="docs/images/LumenX Studio Banner.jpeg" alt="LumenX Studio Banner" width="100%" />
</div>

<div align="center">

# LumenX Studio

### AI 原生短漫剧创作平台
**Render Noise into Narrative**

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Python](https://img.shields.io/badge/python-3.11%2B-blue)](https://www.python.org/)
[![Node](https://img.shields.io/badge/node-18%2B-green)](https://nodejs.org/)
[![GitHub Stars](https://img.shields.io/github/stars/alibaba/lumenx?style=social)](https://github.com/alibaba/lumenx)

[English](README_EN.md) | [中文](README.md) | [用户手册](USER_MANUAL.md) | [贡献指南](CONTRIBUTING.md)

</div>

---

LumenX Studio 是一个**AI 短漫剧一站式生产平台**。它能够将小说文本转化为动态视频，打通了从剧本分析、角色定制、分镜绘制到视频合成的完整创作链路。

LumenX Studio将 **资产提取—>风格定调—>资产生成—>分镜脚本构造->分镜图生成—>分镜视频生成** 的全链路SOP天然与该平台功能集成，在提供完善功能的基础上融入短漫剧行业Know-How，方便大家快速制作出质量过关的AI短片，大大提升生产效率。

本平台天然集成 阿里的Qwen & Wanx 系列模型能力，致力于提供智能便捷、灵活可控的漫剧制作体验，无需频繁切换网页或App，使创作者能够一站式地完成短漫剧制作。

---

## ✨ 核心亮点

| 能力 | 描述 |
|------|------|
| 📝 **深度剧本分析** | 基于 LLM 自动提取角色、场景、道具，生成专业分镜脚本 |
| 🎨 **可控美术指导** | 支持自定义视觉风格，保持全片画风统一 |
| 🎬 **可视化分镜** | 拖拽式分镜编辑器，所见即所得地组合人物、背景与特效 |
| 🎥 **多模态生成** | 集成通义万相 (Wanx) 等模型，支持文生图、图生视频 |
| 🎵 **智能视听合成** | 自动生成角色配音 (TTS)、音效 (SFX) 并合成最终视频 |

---

## 📸 产品演示

<div align="center">
  Step 1: Script 剧本编辑与实体提取
  
  画面左侧置有剧本编辑器，剧本编辑后，可点击上方的“提取实体”按钮，由Qwen-Plus自动提取脚本中所涉及到的角色、场景、道具；右侧可针对这些实体进行编辑调整。
  <img src="docs/images/Script_example.jpg" alt="LumenX Studio Script" width="100%" />

  Step 2: Art Direction 风格定调

  可利用Qwen-Plus分析当前剧本适合的风格，也可使用预设风格，每个风格是由一组 正向/负向提示词 组成，用于在视觉风格上限定后续的所有生成环节，建立全局统一的视觉标准。
  <img src="docs/images/ArtDirection_example.jpg" alt="LumenX Studio ArtDirection" width="100%" />

  Step 3: Assets 资产生成

  该阶段可以为Step 1所抽取的角色、场景、道具等资产进行文本描述编辑，再基于该文本描述生成对应的图片。对于角色而言，为了保持角色在不同场景的一致性，采用先生成人物的无背景全身图，再基于该全身图作为参考图生成对应的 三视图、头像特写 作为该角色的核心资产，后续若涉及到更换服装、形态，皆可以沿用该全身照或三视图进行二次图像编辑得来。
  另外，万相2.6系列支持参考生视频，所以此处也可以为每个橘色、场景、道具生成参考视频。

  <img src="docs/images/Assets_example.jpg" alt="LumenX Studio Assets" width="100%" />

  Step 4 StoryBoard 分镜图故事版

  该阶段可以基于脚本提取分镜脚本，形成结构化的故事版，支持用户的对分镜的二次编辑与增加、删除；对于每个分镜场景可以选择该场景所参与的角色、场景、道具作为参考图，进行分镜图的生成。
  该阶段融入AI提示词润色能力，可以直接利用Qwen-Plus对现有提示词进行润色，已嵌入图像编辑的提示词指南作为最佳实践。

  <img src="docs/images/StoryBoard_example.jpg" alt="LumenX Studio StoryBoard" width="100%" />

  Step 5 Motion 分镜视频生成

  该阶段可分为两种生成模型，一种是基于首帧驱动的i2v模式，另一种是基于角色动作驱动的r2v模式。在i2v模式下，可选取Step 4所生成的分镜图，逐一为其生成分镜视频，该生成过程也已融入AI提示词润色能力，可以直接利用Qwen-Plus对现有提示词进行润色，已嵌入图生视频的提示词指南作为最佳实践。在r2v模式下，可选取角色、场景、道具的参考视频进行参考生视频。
  同时该阶段支持 多Batch Size生成的抽卡机制，可在Step 6针对每个分镜进行最终分镜视频的选取。

  <img src="docs/images/Motion_example.jpg" alt="LumenX Studio Motion" width="100%" />

  Step 6 Assembly 分镜视频拼接

  该阶段可以审查每个分镜的分镜视频，选择你认为最好的，作为最终分镜，全部分镜选择结束后，点击“Merge&Proceed”按钮即可一键拼接成片。

  <img src="docs/images/Assembly_example.jpg" alt="LumenX Studio Assembly" width="100%" />

</div>

---

## 🎬 R2V（Reference-to-Video）工作流

LumenX 同时支持两种制作范式：

- **I2V Legacy**：9 步传统工序，适合需要精细控制每个环节的专业创作者
- **R2V**：4 步简化流程，以参考图驱动端到端生成，面向快速内容生产

### R2V 的 4 步流程

| 步骤 | 说明 |
|------|------|
| **1. Script** | 剧本编辑与实体提取，AI 自动分析角色/场景/道具 |
| **2. Art Direction** | 风格定调，统一视觉标准 |
| **3. Storyboard** | AI 自动生成分镜帧，自动填充资产标签，一键触发视频生成 |
| **4. Assembly** | 分镜视频拼接导出 |

### R2V 与 I2V Legacy 的差异

| 维度 | I2V Legacy | R2V |
|------|-----------|-----|
| 步骤数 | 9 步 | 4 步 |
| 资产生成 | 逐项手工控制（全身像/三视图/头像） | Series 级别共享资产，一次生成全系列复用 |
| 分镜生成 | 手动或按剧本分析 | AI 自动生成 + 资产标签自动填充 |
| 视频策略 | 首帧 I2V | 参考图驱动 R2V，多资产参考保证视觉一致性 |
| 适用场景 | 专业动画/漫剧精制作 | 快速内容生产、系列化短剧 |

### Series（系列）支持

R2V 模式天然支持 Series 维度的资产管理：

- **Series 详情页**：统一管理全系列的角色/场景/道具资产，支持全部批量生成和单个生成
- **资产工作台**：点击角色卡片弹出 CharacterWorkbench，支持正视图/三视图/头像特写等精细编辑
- **自动同步**：Episode 创建时自动将角色/场景/道具合并到父 Series，跨集资产复用

---

## 📋 最新更新

### 2026-06-01

**R2V 分镜自动生成**
- R2V Storyboard 新增「生成分镜」按钮，AI 自动从剧本拆解分镜帧
- 每帧自动填充资产标签，生成视频时直接作为参考图传入
- 视觉氛围、动作描述、对话自动组合为完整 prompt

**资产同步与生成**
- Episode 加入 Series 时自动将角色/场景/道具同步到父 Series
- Series 详情页新增「生成全部图片」按钮和单资产悬停生成按钮
- Series 角色资产支持点击弹出 CharacterWorkbench，复用 I2V 的正视图/三视图/头像编辑能力

**持久化修复**
- 修复删除项目/系列后 SQLite 残留数据问题，delete_project 和 delete_series 显式执行 SQL DELETE

**默认工作流**
- 新建项目和系列的默认 workflow_mode 从 r2v 改为 i2v_legacy

**LLM 适配器（DashScope + OpenAI）**
- 新增 LLMAdapter 统一接口，支持 DashScope 和 OpenAI 兼容 API
- 通过 LLM_PROVIDER 环境变量切换（默认 dashscope，可选 openai）
- 支持配置 OPENAI_API_KEY、OPENAI_API_BASE、OPENAI_MODEL 接入任意第三方 LLM
- DashScope 切换为 OpenAI 兼容端点 (compatible-mode/v1)，支持 qwen3.5-plus 等新模型

**Request Log**
- Series 详情页新增 Request Log 侧边栏，方便调试 API 调用


</div>

---

## 🏗️ 系统架构

LumenX Studio 采用前后端分离的现代化架构，确保了扩展性与性能。

<div align="center">
  <!-- 架构图 -->
  <img src="docs/images/architecture.svg" alt="System Architecture" width="80%" />
</div>

**技术栈：**
- **Frontend**: Next.js 14 + React 18 + TypeScript + Tailwind CSS
- **Backend**: FastAPI + Python 3.11+
- **AI Core**: Alibaba Cloud Qwen (Logic) + Wanx (Visuals)
- **Render**: Three.js (Canvas) + FFmpeg (Video Processing)

---

## 🚀 快速开始

### 1. 环境准备

- **Python**: 3.11+
- **Node.js**: 18+
- **FFmpeg**: 必须安装 (用于视频处理)

### 2. 克隆项目

```bash
git clone https://github.com/alibaba/lumenx.git
cd lumenx
```

### 3. 配置密钥

复制配置文件并填入 API Key（需开通阿里云百炼服务）：

```bash
cp .env.example .env
# 编辑 .env 文件，填入 DASHSCOPE_API_KEY
```

### 4. 启动后端

```bash
# 安装依赖
pip install -r requirements.txt

# 创建输出目录
mkdir -p output/uploads

# 启动服务 (http://localhost:8000)
./start_backend.sh
```

### 5. 启动前端

```bash
cd frontend

# 安装依赖 & 启动服务 (http://localhost:3008)
npm install && npm run dev
```

说明：

- `npm run dev` 现在会走仓库内置的稳定启动器。
- 在 macOS 上，它会默认启用 Watchpack polling，避免大型工作区下出现 `EMFILE: too many open files, watch`，方便继续使用 dev 模式调试。
- 这个仓库的前端默认开发端口现在固定为 `3008`，避免和你本机其他项目常用的 `3000` 冲突。

---

## 📖 文档中心

- **[用户手册](USER_MANUAL.md)**: 必读！详细的功能使用说明。
- **[API 文档](http://localhost:8000/docs)**: 后端接口定义的 Swagger UI。
- **[模型接入实现说明](docs/model-onboarding-implementation.md)**: 解释模型接入系统已经如何落地、每个相关文件负责什么。
- **[模型文档与 catalog 架构设计](docs/plans/2026-04-03-model-docs-and-catalog-architecture.md)**: 解释这套系统为什么这样设计。

---

## 🧠 模型接入工作流

LumenX 现在已经内置了仓库级的模型接入工作流入口：

- 文本别名：`/lumenx-model-onboarding`
- 适用场景：
  - 接入新模型
  - 更新模型版本
  - 修改默认模型
  - 调整模型参数、能力标记、UI 暴露
  - 刷新模型文档证据

推荐操作顺序：

```bash
python scripts/build_model_catalog.py
python scripts/validate_model_catalog.py
pytest -q
cd frontend && npm run typecheck
cd frontend && npm run test:all
cd frontend && npm run build
```

`npm run typecheck` 是一个稳定包装层：如果干净 checkout 里还没有 Next.js 自动生成的 `.next/types`，它会先补一次构建，再继续执行 `tsc --noEmit`。

这套流程的目标不是只“把文件改掉”，而是让每次模型更新都留下：

- 文档证据
- catalog 变更
- 前后端生成物
- 可复现的验证结果

---

## 🧩 运行模式与必填配置

LumenX 采用 **本地优先（local-first）** 的媒体存储逻辑：

- 所有上传/生成媒体都会先写入 `output/`，作为稳定项目数据源。
- OSS 是可选镜像与签名 URL 服务，不是必选前置依赖。
- 提供商路由默认走 DashScope（可按模型家族切换到 vendor-direct）。

### 模式 1：DashScope-only（无 OSS）

- 用途：单机本地创作，不配置 OSS，也不配置原厂 Kling/Vidu Key。
- 必填：`DASHSCOPE_API_KEY`
- 可选：`KLING_PROVIDER_MODE`、`VIDU_PROVIDER_MODE`（默认 `dashscope`）

### 模式 2：DashScope + OSS（本地 + 云镜像）

- 用途：本地持久化 + OSS 备份/签名 URL。
- 必填：
  - `DASHSCOPE_API_KEY`
  - `ALIBABA_CLOUD_ACCESS_KEY_ID`
  - `ALIBABA_CLOUD_ACCESS_KEY_SECRET`
  - `OSS_BUCKET_NAME`
  - `OSS_ENDPOINT`
- 可选：`OSS_BASE_PATH`

### 模式 3：DashScope-first + Kling vendor-direct

- 用途：大部分模型走 DashScope，仅 Kling 走原厂。
- 必填：
  - `DASHSCOPE_API_KEY`
  - `KLING_PROVIDER_MODE=vendor`
  - `KLING_ACCESS_KEY`
  - `KLING_SECRET_KEY`
- 备注：是否配置 OSS 取决于你的存储需求，不影响该模式可用性。

### 模式 4：DashScope-first + Vidu vendor-direct

- 用途：大部分模型走 DashScope，仅 Vidu 走原厂。
- 必填：
  - `DASHSCOPE_API_KEY`
  - `VIDU_PROVIDER_MODE=vendor`
  - `VIDU_API_KEY`
- 备注：是否配置 OSS 取决于你的存储需求，不影响该模式可用性。

---

## ⚙️ 进阶配置

<details>
<summary>点击展开详细配置说明</summary>

### OSS 对象存储（推荐）
为了安全和性能，建议配置阿里云 OSS 存储生成的媒体文件：

1. 创建 **私有 (Private)** Bucket
2. 在 `.env` 或应用设置中配置：
   ```env
   ALIBABA_CLOUD_ACCESS_KEY_ID=...
   ALIBABA_CLOUD_ACCESS_KEY_SECRET=...
   # 在应用内配置 Bucket 名称和 Endpoint
   ```

### 配置文件路径
- **开发模式**: 项目根目录 `.env`
- **打包应用**: 用户主目录 `~/.lumen-x/config.json`

</details>

---

## 📁 目录结构

```
lumenx/
├── frontend/          # Next.js 前端工程
├── src/               # Python 后端核心
│   ├── apps/         # 业务逻辑
│   ├── models/       # AI 模型接口
│   └── utils/        # 工具库
├── output/            # (自动生成) 项目输出目录
```

---

## 🤝 参与贡献

我们非常欢迎社区贡献！请先阅读 [贡献指南](CONTRIBUTING.md) 了解代码规范和提交流程。

- **Bug 反馈**: 请提交 [GitHub Issues](https://github.com/alibaba/lumenx/issues)
- **功能建议**: 欢迎在 [Discussions](https://github.com/alibaba/lumenx/discussions) 中讨论

## 👤 作者与联系方式

本项目由 **星莲 (StarLotus)** 主导开发与维护。

如果您在使用过程中遇到问题，或有任何建议，欢迎通过以下方式联系：

- **反馈与交流**: [GitHub Issues](https://github.com/alibaba/lumenx/issues)
- **技术讨论**: [GitHub Discussions](https://github.com/alibaba/lumenx/discussions)
- **邮件联系**: [zhangjunhe.zjh@alibaba-inc.com](mailto:zhangjunhe.zjh@alibaba-inc.com)

---

## 📄 许可证

本项目基于 [MIT License](LICENSE) 开源。

---

<div align="center">
  Made with ❤️ by Alibaba Group
</div>
