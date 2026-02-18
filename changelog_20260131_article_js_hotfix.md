# v8.16.16 Hotfix — Article pages stuck on “校验权限中…”

## 问题
- 写文章页（article-editor.html）停留在“校验权限中…”
- 文章详情页（article.html）可能无法正常渲染正文
- 控制台会报 JS 语法错误（Invalid regular expression / missing /）

## 根因
- v8.16.15 在升级富文本/媒体块渲染时，`article-editor.js` 与 `article.js` 的 `mdToHtml()` 发生了重复拼接，
  导致脚本中出现非法片段 `}/g, ...`，引发语法错误，后续初始化逻辑无法执行。

## 修复
- 重新整理并“只保留一份” `mdToHtml()` 实现（含媒体块独立化 + 连续图片自动网格 + PDF 统一附件块）
- 修复 `article-editor.html` / `article.html` 的脚本版本号，避免浏览器继续命中旧缓存：
  - article-editor.js?v=20260131_003
  - article.js?v=20260131_003
