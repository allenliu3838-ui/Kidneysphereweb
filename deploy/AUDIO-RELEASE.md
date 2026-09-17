# 音视频课程更新

本次更新包含 6 个前端资源和 2 个 API 处理器。不会修改数据库结构、课程权益、已有媒体文件或其他站点。`kind` 继续使用 `aliyun`，音频和视频共用管理员上传验证与 `check_video_access`。

## 使用方式

学习中心 → 新增视频 / 音频 → 阿里云点播 → 上传视频 / 音频。保留课程标题、主讲人、专科和访问权限，上传后自动填写媒体 ID。可先保存草稿，在阿里云完成转码和试听后再上架；站内草稿不开放播放。

上传支持原有视频格式，以及 MP3、M4A、WAV、AAC、FLAC、WMA、APE，单文件上限仍为 2 GB。建议先用 MP3 验收。非 MP3 音频需要云端转码生成 MP3；上传完成不代表已经生成可播放音频。

阿里云默认模板取决于账号配置。若现有模板不能处理纯音频，应建立输出 MP3 的音频模板组，再在实际 API 服务环境配置 `ALIYUN_VOD_AUDIO_TEMPLATE_GROUP_ID`。这是可选的服务端配置，仅应用于音频；更新包不会代填模板或修改环境文件。

阿里云依据：[上传格式](https://help.aliyun.com/zh/vod/user-guide/media-uploader-t)、[上传凭证](https://help.aliyun.com/zh/vod/developer-reference/api-vod-2017-03-21-createuploadvideo)、[音视频播放信息](https://help.aliyun.com/zh/vod/developer-reference/api-vod-2017-03-21-getplayinfo)。

## 发布

将离线包上传至服务器 `/root/`，核对交付时提供的 SHA-256 后执行 `python3 包文件.pyz --inspect`。检查默认只读：由 3001 端口定位真实的 Node 入口、后端路径和管理器。只接受已核实的 root PM2 单进程或 systemd 单元；未知运行方式、文件被另行修改或路径不符时拒绝更新。

检查成功会输出带 `--expect-inspection` 的 `APPLY_COMMAND`。该命令会再次检查现场、备份到 `/root/kidneysphere-audio-releases/`、替换固定 8 个文件，仅重启确认的 API 进程，并验证接口健康、未登录拒绝访问和页面资源。不会重启 Nginx 或其他业务进程。

保留安装输出中的 `BACKUP` 和 `ROLLBACK_COMMAND`。回滚校验备份及当前文件，拒绝覆盖安装后另行修改的资源；不要用旧的首页或全站主题包覆盖本次学习/播放页面。

## 上线验收

1. 管理员上传一份真实 MP3，确认自动填写媒体 ID，保存课程并在云端确认处理完成。
2. 上架后用有权限的账号播放、暂停、拖动进度和调整倍速；手机再检查一次。
3. 无对应权益账号应被拒绝播放付费音频，未登录应提示登录。
4. 复测一节原有付费视频及培训课程，确认原权益继续生效。
5. 如需 M4A / WAV，再上传一份，确认云端转码产生 MP3 后站内可播放。

本地自动化测试使用模拟 HTTP 边界；独立播放器预览使用合成测试音。这两项验证不能替代实际阿里云上传、真实会员权限与付费视频回归。
