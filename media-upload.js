// ApsaraVideo VOD audio and video share the existing upload credentials API.
// Audio input formats: https://help.aliyun.com/zh/vod/user-guide/media-uploader-t
export const AUDIO_EXTENSIONS = Object.freeze(['mp3', 'm4a', 'wav', 'aac', 'flac', 'wma', 'ape']);
export const VIDEO_EXTENSIONS = Object.freeze(['mp4', 'mov', 'm4v', 'mkv', 'avi', 'flv', 'wmv', 'webm', 'ts']);
export const MEDIA_ACCEPT = [...VIDEO_EXTENSIONS, ...AUDIO_EXTENSIONS].map(ext => '.' + ext).join(',');
export const MAX_MEDIA_BYTES = 2 * 1024 * 1024 * 1024;

export function validateMediaFile(file) {
  const extension = String(file?.name || '').match(/\.([^.]+)$/)?.[1]?.toLowerCase() || '';
  const mediaType = AUDIO_EXTENSIONS.includes(extension) ? 'audio'
    : VIDEO_EXTENSIONS.includes(extension) ? 'video' : null;
  if (!mediaType) return { error: '请选择支持的视频或音频文件。音频支持 MP3 / M4A / WAV / AAC / FLAC / WMA / APE。' };
  if (!Number.isFinite(file.size) || file.size <= 0) return { error: '文件为空，请重新选择。' };
  if (file.size > MAX_MEDIA_BYTES) return { error: '单文件不能超过 2 GB，请压缩后再上传。' };
  return { mediaType, extension };
}
