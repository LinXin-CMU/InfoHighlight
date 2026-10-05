# 本地阅读服务

当前实现、模型分工和启动方法见 [仓库说明](../README.md)。阅读规则及开发案例见 [作品说明](../docs/PROJECT_CASE.md)。

核心入口包括 `local-provider.mjs`、`mica-provider.mjs`、`model-worker.py`、`mica_worker.py` 和 `translation_worker.py`；`server.mjs` 负责工作台及阅读任务 API，`real-launcher.mjs` 启动真实本地模型服务。
