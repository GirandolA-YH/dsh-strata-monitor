# 第三方组件声明

本插件（`strata-monitor`）自身以 **MIT** 授权发布，见 [LICENSE](LICENSE)。
但它**内嵌了一份第三方字体**，该字体不适用 MIT，必须单独遵守其授权。

## Outfit 字体 —— SIL Open Font License 1.1

- **位置**：`lib/client.js` 中的 `FONT_B64` 常量（一份 base64 编码的 Outfit 可变字体 woff2，
  latin 与 latin-ext 子集），用于让面板的视觉与 Strata 自带的监控面板保持一致。
- **版权**：Copyright 2021 The Outfit Project Authors
  (<https://github.com/Outfitio/Outfit-Fonts>)
- **授权**：SIL Open Font License, Version 1.1
- **全文**：[licenses/OFL-Outfit.txt](licenses/OFL-Outfit.txt)

OFL 要求授权文本随字体一起分发，本文件与 `licenses/OFL-Outfit.txt` 就是为此存在。
**如果你把字体换掉**（例如删掉 `FONT_B64`、改用系统字体），就可以一并删除本文件与
`licenses/` 目录。

> 字体数据最初取自 Strata 仓库的 `serve/web/fonts/`；Strata 自己也以同样方式内嵌它。
