# Margin

Margin 是一个本地优先的极简 AI PDF 阅读器：导入 PDF、自动跟踪当前页，并让侧边栏 AI 基于当前页和全文检索结果进行解释与问答。

## 当前能力

- Electron Windows 桌面壳，PDF 解析与页面文本提取均在本机完成
- 当前页自动同步到 AI 上下文
- 内存向量索引，检索结果保留原始页码
- 内置 `Qwen/Qwen3-Embedding-4B` 官方 Q4_K_M GGUF 模型适配器
- 自定义 OpenAI-compatible 对话与向量端点、模型名和独立 API Key
- Hugging Face 下载失败时自动回退 ModelScope，并校验模型 SHA-256

## 开发

需要 Node.js 22.13 或更高版本。

```powershell
npm install
npm run desktop:dev
```

验证与无模型桌面打包：

```powershell
npm run lint
npm run lint:electron
npm run desktop:pack
```

## 本地模型包

Qwen3-Embedding-4B 并非小模型：官方 BF16 权重约 8.06 GB，本项目固定使用约 2.50 GB 的官方 Q4_K_M GGUF。模型文件不会进入 Git。默认安装到 `%APPDATA%\Margin\models`，桌面主进程管理固定版本的 llama.cpp 本地服务；可通过 `MARGIN_DATA_ROOT` 改写数据根目录。

```powershell
npm run model:bundle
npm run desktop:release:bundled
```

下载顺序为 Hugging Face → ModelScope → Hugging Face 国内镜像，模型与 llama.cpp Windows CPU 运行时都会验证固定 SHA-256。低内存设备建议先使用自定义 OpenAI-compatible 向量端点。GitHub 自动发布的是不含模型资源的轻量程序壳；模型安装在独立用户目录中。

## 发布流程

所有功能从独立分支提交，通过 Pull Request 合并到 `main`。CI 会检查代码、Electron 主进程语法和静态构建；`v*.*.*` 标签创建 Windows 草稿 Release。细节见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 隐私边界

PDF 字节不会自动上传。仅在发起 AI 问答时，当前页文本与命中的片段会发送给用户配置的对话端点。API Key 只保存在本机浏览器存储中，不应提交到仓库。
