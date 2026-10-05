# Windows 托盘控制器

托盘程序管理本地阅读服务，支持预加载、暂停新任务、卸载模型、停止服务和登录自启。源码为 `InfoLensHost.cs` 及 `FloatingController.cs`，运行 `build.ps1` 可编译为 `InfoLensHost.exe`。

`host-config.json` 包含 Node 可执行路径、`infolens-prototype/real-launcher.mjs` 路径及端口，由 `configure-local.mjs` 生成。退出运行中的托盘程序后再重建。配置和使用方法见 [仓库说明](../README.md)。
