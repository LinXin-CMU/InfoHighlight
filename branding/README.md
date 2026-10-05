# InfoLens 阅读透镜

已采用 A 方案。圆环表示聚焦，三条横线表示文字，中间珊瑚红横线表示阅读重点。托盘版去掉上下两条文字线，保留圆环和高亮线。石墨灰底在深浅任务栏上都保持对比。

`infolens.svg` 是主图标，`infolens-tray.svg` 是托盘图标。PNG 和 ICO 含 16、20、24、32、48、64、128、256 px；Windows EXE 嵌入主图标和托盘资源。网页、Edge 和 VS Code 复用主图标。

修改矢量几何时同步 `generate-icons.py`，用装有 Pillow 的 Python 运行它，再重建 Windows Host 和 VSIX。图标仅表示应用身份；暂停、连接和模型状态继续由文字和控制按钮显示。
