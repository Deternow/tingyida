# 听译答

**语音转写 · 网页翻译 · AI 做题** —— 一个跑在本机的 Chrome / Edge 侧边栏助手

**English name:** TingYiDa · Speech Transcription, Webpage Translation & AI Quiz Assistant

Manifest V3 扩展，三种能力共用一套本地后端：录音交给本地 Vosk 转成文字，网页英文交给本地翻译模型变成中文，题目内容交给本地 Qwen 或你自备的云端 OpenAI 兼容 API 作答。单词拆开正好是名字：**听**（语音转写）、**译**（英文转中文）、**答**（AI 做题）。

除你主动启用的云端做题外，全部推理都在本机完成；录音 WAV 始终不离开本地。

## 功能

| 功能 | 说明 |
| --- | --- |
| 语音转写 | 录制系统播放声音、当前标签页音频或麦克风音频；使用本地 Vosk 模型转写英文或中文。 |
| 网页翻译 | 将网页中的英文翻译成中文，并显示在原文下方；可清除译文。页面文本在发送前会过滤掉中文和其他非拉丁文字。 |
| AI 辅助做题 | 选择本地 Qwen 或云端 API；将页面内容和录音转写文本交给模型，生成中文解析、要点和答案总结。云端模式可选附带完整 HTML。做题只发送文字，录音 WAV 不出本机。 |
| 录音历史 | 保存 WAV 音频、识别文本和翻译结果；可回放、翻译、删除，也可多选录音用于做题。 |
| 侧边栏与网页面板 | 可从浏览器侧边栏或网页悬浮按钮打开功能面板，两种入口共享本地历史记录。 |

## 环境要求

- Windows 10/11：项目附带的 `.bat` 启动脚本和“整个电脑声音”录制使用 Windows 能力。
- Chrome 或 Edge 119 及以上版本。
- Python 3.10 或更高版本（**仅源码方式运行需要**；用打包版 `听译答服务.exe` 可完全不装 Python）。
- 本地做题需要 Ollama 与项目 `models/qwen/` 目录中的 Qwen 模型，默认连接 `127.0.0.1:11435`。推荐 `qwen3.5:9b`，模型文件约 6.6 GB。
- 云端做题需要用户自行提供兼容 OpenAI Chat Completions 的接口地址、API Key 和模型名称，纯文字模型即可（无需音频能力）。
- 首次安装 Python 依赖或下载模型需要网络。

## 安装与运行

> 想要开箱即用：到 **Releases** 下载 `TingYiDa-2.3.0.zip`。压缩包已内置 `听译答服务.exe`（免装 Python）、
> 英文/中文 Vosk 识别模型与 Argos 英译中模型，解压后双击 `启动本地服务.bat` 即可转写和翻译。
> **只有本地做题的 Qwen 模型（6.6 GB）需要另行下载**（见第 4 节）。
> 仓库源码本身不含 exe 与模型，按下面的步骤自行构建也能跑。

### 1. 启动后端服务（二选一）

**方式 A：直接用打包版（推荐，本机无需安装 Python）**

下载/解压后项目根目录会有 `听译答服务.exe`，双击 `启动本地服务.bat` 即可——脚本检测到 exe 就优先运行它，检测不到才回退到 Python 源码。也可以直接双击 `听译答服务.exe`。

首次启动需要把运行库解包到临时目录，约 5–10 秒；之后常驻内存，不再重复解包。若杀毒软件拦截，请把该 exe 加入信任。

**方式 B：用 Python 源码运行（开发调试用）**

在项目根目录打开命令提示符：

```bat
py -3 -m venv .venv
.venv\Scripts\activate
python -m pip install --upgrade pip
python -m pip install flask vosk ctranslate2 sentencepiece
```

可选安装 `soundcard`，用于录制整个电脑正在播放的声音：

```bat
python -m pip install soundcard
```

“当前标签页”和“麦克风”录音不依赖 `soundcard`。启动后端并保持命令窗口开启：

```bat
python server\server.py
```

服务默认监听 `http://127.0.0.1:8765`。也可以使用根目录的 `启动本地服务.bat`，脚本会从 Windows `PATH` 中查找 `python.exe`。

### 2. 准备语音识别和翻译模型

**用 Release 压缩包的话这一步可以跳过**：包内已带 `models/vosk/`（英/中）与 `models/en_zh/`，开箱即可转写和翻译。

从源码运行或模型缺失时，模型放在项目根目录的 `models/` 下，执行：

```bat
python server\install_asr_model.py
python server\install_translation_model.py
```

`install_asr_model.py` 只下载英文 Vosk 模型；中文模型可从 [Vosk 模型页面](https://alphacephei.com/vosk/models)获取，并解压到 `models/vosk/vosk-model-small-cn-0.22/`。

### 3. 加载浏览器扩展

1. 在 Chrome 打开 `chrome://extensions`，或在 Edge 打开 `edge://extensions`。
2. 开启“开发者模式”。
3. 点击“加载已解压的扩展程序”，选择项目里的 `extension/` 目录。
4. 打开或刷新要使用的网页，再从扩展图标或网页悬浮按钮打开面板。

访问跨域 iframe 或本地 `file://` 页面时，浏览器可能要求授予可选权限。

### 4. 配置做题模型

**本地 Qwen：**双击 `安装本地模型.bat`，它会依次做三件事，全程只需在“是否下载”处按一次回车：

1. **检测 Ollama**：找不到就用 winget 安装；winget 不可用时自动回退到 Ollama 官方安装脚本。
2. **检测/下载模型**：检查 `models/qwen/` 里是否已有 `qwen3.5:9b`，没有才询问并下载（约 6.6 GB）。下载走独立的 `127.0.0.1:11435` 服务，不会关闭你正在用的 Ollama；已有模型则直接跳过。
3. **绑定模型目录**：用 `setx OLLAMA_MODELS` 把 Ollama 的模型目录指向项目的 `models/qwen`，之后命令行 `ollama list` 与本地服务都认这个位置。解除绑定执行 `setx OLLAMA_MODELS ""`。

三步都已完成时再次运行只会打印状态，不会重复下载。装完后重启 `启动本地服务.bat` 并刷新扩展，面板顶部会显示 `本地模型:qwen3.5:9b`；不装本地模型也可以只用云端 API。

**云端 API：**启动本地服务后，打开侧边栏“设置”，填写兼容 OpenAI Chat Completions 的接口地址、模型名称和 API Key，点击“保存云端配置”；再到“做题”卡片把“作答模型”切到“云端 API（Key）”。如果本机没装 Qwen，扩展会在启动检测时把“本地 Qwen”置灰并自动锁定云端，此时只填好 API 就能用。API Key 由本机 Flask 服务写入 `data/cloud_config.json`，不保存在浏览器扩展存储，也不会由配置读取接口回传。该文件已加入 `.gitignore`；仍应避免手动提交或分享此文件。

“将当前网页完整 HTML 发给云端”默认勾选，可在设置中取消。HTML 取自当前标签页顶层文档，会随页面可见文本（含中文）、录音识别文本一起发送到你配置的服务商。做题链路只外发文字：录音 WAV 只保存在本机 `recordings/`，不会上传，因此纯文字模型即可胜任云端做题。本地与云端两种模式共用同一份系统提示词和同样的文字输入。

## 使用说明

### 语音转写

在面板选择音源和识别语言，再开始录制：

- **整个电脑的声音**：通过 Windows WASAPI 回环录制系统播放音频，需要 `soundcard`。
- **当前标签页**：在浏览器弹窗中选择标签页并允许分享标签页音频。
- **麦克风**：通过浏览器请求麦克风权限。

录音和历史记录保存在项目的 `recordings/` 与 `data/history.json`。

### 网页翻译

点击“翻译本页英文”后，符合条件的英文内容会在原文下方显示中文译文；混合中英文文本会在发送到本地翻译服务前剔除中文和其他非拉丁文字。

### AI 辅助做题

在“做题”卡片顶部的“作答模型”下拉里选择本地 Qwen 或云端 API，选择会记住。打开面板时本地服务会检查 `models/qwen` 与 Ollama：两者缺一就把“本地 Qwen（未安装）”置灰、自动切到云端，并在下拉下方写明原因；云端未配置时同样会提示并阻止提交。点击“做题”后，扩展收集当前页面的可见文本（英文、中文都收），并附上所选录音的识别文本。历史列表中的“用于做题”复选框支持多选；未勾选录音时沿用当前选中或最近一条有识别文本的录音。云端模式默认附带完整 HTML，可在设置里关掉。两种模式都只发文字，录音 WAV 不上传。

解答默认按 **【解析】→【要点】→【答案总结】** 的顺序输出。若页面原文与录音内容冲突，系统提示词要求优先参考页面原文。长文本可能因模型上下文限制而截断。

## 数据与隐私

- Flask 后端默认只监听本机地址 `127.0.0.1:8765`。本地模式的 AI 请求只连接本机 Ollama。
- 云端模式只向用户配置的 API 地址发送做题请求，且只发文字：页面可见文本（含中文）、录音转写文本，以及默认附带的完整 HTML（可在设置中取消）。录音 WAV 不上传。
- API Key 存储在本机 `data/cloud_config.json`，配置读取接口仅返回是否已配置，不返回密钥。Windows 文件权限通常继承项目目录权限，请为当前 Windows 用户保护该目录。
- 云端服务商可能记录或处理收到的数据；不要将敏感网页或个人信息发送给云端。
- 录音与历史记录在本地项目目录保存。公开仓库前应检查 Git 跟踪状态，并排除模型权重、录音、历史记录和云端配置。

## GitHub 发布注意

不要把整个 `models/qwen/` 目录直接提交到普通 Git 仓库。它包含数 GB 模型文件，远超 GitHub 普通 Git 单文件 100 MiB 限制。仓库 `.gitignore` 已排除虚拟环境、缓存、录音、历史记录、云端 API 配置和 `models/qwen/`。若相关文件此前已被 Git 跟踪，仅添加忽略规则不会自动从版本库移除它们。

发布前还应检查识别/翻译模型的上游许可，并为项目添加适用的开源许可证。公开代码不代表第三方模型权重也可不受限制地再分发。

### 第三方模型与许可

| 组件 | 来源 | 许可 |
| --- | --- | --- |
| Vosk 识别模型（`vosk-model-small-en-us-0.15`、`vosk-model-small-cn-0.22`） | [alphacephei.com/vosk](https://alphacephei.com/vosk/models) | Apache-2.0 |
| Argos 英译中模型（`translate-en_zh-1_9`） | [Argos Translate](https://www.argosopentech.com/) / OPUS-MT | MIT（模型基于 OPUS-MT，遵循其 CC-BY-4.0 条款） |
| Qwen3.5:9b（不随包分发） | [Ollama 模型库](https://ollama.com/library/qwen3.5) | Apache-2.0 |

Release 压缩包内置前两项，仅作离线推理使用，未做任何修改；如需再分发请保留上述署名与许可信息。

## 目录结构

```text
.
├── extension/                  # Chrome / Edge 扩展
├── 听译答服务.exe               # 打包版后端（免安装 Python，可选）
├── server/                     # Python 源码（开发调试用）
│   ├── server.py
│   ├── translator.py
│   ├── qwen.py
│   ├── install_asr_model.py
│   └── install_translation_model.py
├── models/                     # Vosk、Argos 和本地 Ollama 模型
├── recordings/                 # 运行时录音
├── data/history.json           # 运行时历史记录
├── data/cloud_config.json      # 本机云端配置（忽略，不提交）
├── 启动本地服务.bat
├── 安装本地模型.bat
└── .gitignore
```

## 常见问题

| 现象 | 检查方式 |
| --- | --- |
| 面板显示本地服务未连接 | 确认 `python server\server.py` 正在运行，且 8765 端口未被占用。 |
| 语音识别不可用 | 确认对应语言的 Vosk 模型目录完整，并已安装 `vosk`；系统声音录制还需要 `soundcard`。 |
| AI 做题提示本地模型不可用 | 面板顶部状态与“作答模型”下方会直接给出原因（缺目录 / 无模型文件 / 未装 Ollama）。装好模型后重开面板即恢复；期间可继续用云端 API。 |
| 云端 API 调用失败 | 检查接口地址、模型名称和网络；确认服务兼容 `/chat/completions` 且支持纯文字多模态消息格式。 |
| 扩展重载后网页功能没有更新 | 刷新目标网页，使扩展内容脚本重新加载。 |

## 版本

当前扩展版本：`2.3.0`，后端提供免安装 Python 的 `听译答服务.exe`。
