# 2026-07-05 修复阿里云 VOD 视频无法播放

## 问题
学习中心播放页（watch.html）里，通过阿里云 VOD 上传的视频（`kind='aliyun'`）
播放器能出现，但黑屏卡在 0:00，视频加载不出来。

## 根因
`/api/videos/:id/play-auth` 通过阿里云 `GetPlayInfo` 拿到播放地址后，直接塞进
原生 HTML5 `<video>`。两个问题导致无法播放：

1. **混合内容**：阿里云 VOD 默认返回 `http://` 播放地址，站点是 `https://`，
   浏览器（及 CSP `media-src https:`）会拦截 http 媒体 → 黑屏。
2. **HLS 无法原生播放**：阿里云默认转码常产出 HLS(m3u8) 流，桌面 Chrome/Firefox
   的原生 `<video>` 不支持 HLS（仅 Safari 支持）→ 黑屏。

## 修复
- `netlify/functions/video-play-auth.js`
  - `GetPlayInfo` 结果里**优先选择 MP4** 格式（各浏览器原生可播），无 MP4 才退回首个。
  - 把返回的播放地址与 fallback 地址统一**强制改成 https://**。
- `watch.html` `initUrlPlayer`
  - 播放地址强制 https。
  - 检测到 HLS(m3u8) 时：Safari/iOS 走原生；其他浏览器动态加载 hls.js
    （jsdelivr，已在 CSP script-src 白名单内）后播放。
