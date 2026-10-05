# InfoHighlight 本地智能阅读助手

InfoHighlight 帮助读者在网页、技术文档和论文中定位重点，并在 Zotero 中阅读原位译文。项目基于 [dqy08/InfoLens](https://github.com/dqy08/InfoLens) 的信息密度高亮方案，增加句子重要度融合、中文整词显示、跨应用设置和本地翻译。

[作品说明](docs/PROJECT_CASE.md)介绍阅读需求、显示规则、实现过程和模型选型。

## 模型分工

| 任务 | 模型 | 运行方式 |
| --- | --- | --- |
| 原文信息密度 | Qwen2.5-1.5B Base | BF16，读取原文词元概率 |
| 段落中的句子重要度 | Mica 4B | Q5_K_M，直接读取评分选项概率 |
| 原位翻译 | HY-MT1.5-1.8B | NF4，生成段落译文 |

三类任务通过本机服务共享已经加载的模型，在 12GB 显存下串行调度。高亮先显示信息密度结果，再补充句子评分。模型权重独立准备，仓库包含源码、模型清单及许可证。

## 目录

- `infolens-prototype`：阅读工作台、本地推理服务、模型进程和测试。
- `edge-extension`：网页阅读扩展及 Native Messaging 桥接。
- `vscode-extension`：编辑器高亮扩展。
- `zotero-plugin`：论文高亮和原位翻译。
- `windows-host`：托盘控制器的 C# 源码及构建脚本。
- `branding`：界面图标。

## 运行

Node.js 22 及以上可运行工作台和自动化测试：

```powershell
cd infolens-prototype
node --test
node server.mjs
```

`server.mjs` 启动规则演示，真实本地推理使用 `real-launcher.mjs`。配置时复制 `local-config.example.json` 为 `local-config.json`，填写 Python、模型目录及 Mica 的 llama.cpp 运行目录。Python 依赖见 `requirements-runtime.txt` 和 `requirements-verified.txt`；Mica 运行时采用 llama.cpp CUDA，模型文件及可执行程序由本机提供。

```powershell
node real-launcher.mjs
```

工作台地址为 `http://127.0.0.1:43187/`。Windows 托盘程序可执行 `windows-host/build.ps1` 编译。Edge 桥接可执行 `edge-extension/native/build.ps1` 编译，再运行 `configure-local.mjs --python <Python路径> --model <Qwen目录> --translation-model <HY-MT目录>`，生成托盘及桥接配置；该命令还会核验模型清单。随后按 `local-config.example.json` 将 `mica` 配置补入生成的 `local-config.json`，执行 `edge-extension/安装本机桥接.ps1` 注册桥接，并加载 Edge 解压缩扩展。

Zotero 安装包由 `zotero-plugin/build-xpi.py` 生成，各阅读扩展的使用入口见对应目录 README。实际机器配置和编译产物保存在本地。

## 来源

上游源码及高亮方案的声明见 [NOTICE.md](NOTICE.md) 和 [LICENSE](LICENSE)。模型许可证分别保留在推理服务目录，下载权重时同时遵循对应模型的使用条款。
