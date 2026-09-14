import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const read = name => readFileSync(new URL('../' + name, import.meta.url), 'utf8');
const { validateMediaFile, MEDIA_ACCEPT, MAX_MEDIA_BYTES } = await import('data:text/javascript;base64,' + Buffer.from(read('media-upload.js')).toString('base64'));
const source = read('learning-center.js');
const setup = source.slice(source.indexOf('function setupAliyunDirectUpload()'), source.indexOf('// Run after DOM is ready'));
class Element {
  constructor() { this.dataset = {}; this.style = {}; this.value = ''; this.disabled = false; this.files = []; this.listeners = {}; this.textContent = ''; }
  addEventListener(event, listener) { this.listeners[event] = listener; }
  click() { return this.listeners.click?.(); }
}
function harness({ fail = false, onCredentials, initialVid = '' } = {}) {
  const ids = ['videoAliyunFile','videoAliyunFileBtn','videoAliyunCancelBtn','videoAliyunFileStatus','videoAliyunUploadProgress','videoAliyunUploadBar','videoAliyunUploadText','videoAliyunVid','videoTitle'];
  const elements = Object.fromEntries(ids.map(id => [id, new Element()]));
  elements.videoAliyunVid.value = initialVid;
  const els = { videoSave: new Element(), videoSaveDraft: new Element(), videoSourceType: new Element() };
  const calls = [], uploads = [], deletes = [], alerts = [];
  const state = { document: { getElementById: id => elements[id] }, els, validateMediaFile, alert: x => alerts.push(x), confirm: () => true, console: { error() {} }, atob: x => Buffer.from(x, 'base64').toString(), _currentUpload: null, _mediaSaveInProgress: false,
    supabase: { auth: { getSession: async () => ({ data: { session: { access_token: 'test-admin-token' } } }) } },
    loadOssSdk: async () => {},
    aliyunDeleteOrphan: async (...args) => deletes.push(args),
    fetch: async (url, options) => { calls.push({url,...options}); await onCredentials?.(elements,els); return {ok:true,json: async () => ({videoId:'test-vod-id',uploadAuth:Buffer.from(JSON.stringify({Region:'cn-shanghai'})).toString('base64'),uploadAddress:Buffer.from(JSON.stringify({FileName:'vod/input',Bucket:'test'})).toString('base64')})}; },
    window: { OSS: class { cancel() {} async multipartUpload(name, file, options) { uploads.push({name,file,options}); if(fail) throw new Error('network interrupted'); options.progress(1); } } },
  };
  vm.createContext(state); vm.runInContext(setup + '\nsetupAliyunDirectUpload();', state);
  return {elements,els,calls,uploads,deletes,alerts,state,async select(name, size=10) {elements.videoAliyunFile.files=[{name,size}];return elements.videoAliyunFile.listeners.change();}};
}
test('supports official audio extensions, case-insensitive, and all previously accepted video formats', () => {
  for (const ext of ['mp3','M4A','wav','aac','flac','wma','ape']) {
    assert.equal(validateMediaFile({name:'教学.'+ext,size:10}).mediaType,'audio');
    assert.ok(MEDIA_ACCEPT.includes('.'+ext.toLowerCase()));
  }
  for (const ext of ['mp4','mov','m4v','mkv','avi','flv','wmv','webm','ts']) assert.equal(validateMediaFile({name:'lecture.'+ext,size:10}).mediaType,'video');
});
test('blocks disguised, empty, oversized and unknown files before requesting credentials', async () => {
  for (const [name,size] of [['voice.mp3.exe',5],['voice.ogg',5],['voice.mp3',0],['voice.mp3',MAX_MEDIA_BYTES+1]]) {
    const h=harness();await h.select(name,size);assert.equal(h.calls.length,0);assert.equal(h.alerts.length,1);
  }
  assert.equal(validateMediaFile({name:'lecture.mp3',size:MAX_MEDIA_BYTES}).mediaType,'audio');
});
test('MP3 uses same authenticated VOD direct upload and fills the existing course fields', async () => {
  const h=harness({onCredentials: (_elements,els) => {
    assert.equal(els.videoSave.disabled,true); assert.equal(els.videoSaveDraft.disabled,true); assert.equal(els.videoSourceType.disabled,true);
  }});
  await h.select('临床学习.MP3');
  assert.equal(h.calls[0].url,'/api/videos/upload-credentials');
  assert.equal(h.calls[0].headers.Authorization,'Bearer test-admin-token');
  assert.deepEqual(JSON.parse(h.calls[0].body),{title:'临床学习',fileName:'临床学习.MP3'});
  assert.equal(h.uploads.length,1);assert.equal(h.uploads[0].file.name,'临床学习.MP3');
  assert.equal(h.elements.videoAliyunVid.value,'test-vod-id');assert.equal(h.elements.videoTitle.value,'临床学习');
  assert.match(h.elements.videoAliyunUploadText.textContent,/音频上传成功/);assert.equal(h.els.videoSave.disabled,false);
});
test('existing MP4 still follows original VOD multipart upload', async () => {
  const h=harness();await h.select('clinical.mp4');assert.equal(h.uploads.length,1);assert.match(h.elements.videoAliyunUploadText.textContent,/视频上传成功/);
});
test('cancel during credential request never starts media upload and cleans only this attempt', async () => {
  const h=harness({initialVid:'previous-course',onCredentials: async e => {await e.videoAliyunCancelBtn.click();}});
  await h.select('new.mp3');assert.equal(h.uploads.length,0);assert.deepEqual(h.deletes,[['test-vod-id','test-admin-token']]);
  assert.equal(h.elements.videoAliyunVid.value,'previous-course');assert.match(h.elements.videoAliyunUploadText.textContent,/已停止/);assert.equal(h.els.videoSave.disabled,false);
});
test('upload failure preserves previous course ID and restores disabled state', async () => {
  const h=harness({fail:true,initialVid:'previous-course'});h.els.videoSaveDraft.disabled=true;
  await h.select('new.wav');assert.equal(h.elements.videoAliyunVid.value,'previous-course');assert.equal(h.els.videoSave.disabled,false);assert.equal(h.els.videoSaveDraft.disabled,true);assert.equal(h.deletes.length,1);
});
test('VOD saving keeps access metadata and fails closed on schema errors', () => {
  const save=source.slice(source.indexOf('async function saveVideo'),source.indexOf('async function deleteVideo'));
  assert.match(save,/if\(_currentUpload\)/);
  assert.match(save,/sourceType !== 'aliyun_vod' && \/access_type/);
  assert.doesNotMatch(save,/delete row\.aliyun_vid/);
  assert.match(save,/access_type: accessType/);assert.match(save,/membership_accessible: membershipAccessible/);
});
test('a save in flight blocks a second upload and keeps VOD access fields intact', async () => {
  const h=harness();
  let ready, saved;
  const ensure = new Promise(resolve => {ready=resolve;});
  Object.assign(h.els, {videoTitle:h.elements.videoTitle,videoAliyunVid:h.elements.videoAliyunVid,videoCategory:new Element(),videoAccessType:new Element(),videoAliyunUrl:new Element()});
  h.elements.videoTitle.value='会员音频';h.elements.videoAliyunVid.value='vod-audio';
  h.els.videoCategory.value='glom';h.els.videoSourceType.value='aliyun_vod';h.els.videoAccessType.value='paid_membership';h.els.videoAliyunUrl.value='https://example.com/old.mp4';
  Object.assign(h.state, {isConfigured:()=>true,ensureSupabase:()=>ensure,toast:()=>{},looksLikeHtml:()=>false,getCheckedSpecialtyIds:()=>[],loadAdminVideos:async()=>{}});
  h.state.document.querySelectorAll=()=>[];
  h.state.supabase.from=()=>({insert:async row => {saved=JSON.parse(JSON.stringify(row));return {error:null};}});
  const save=source.slice(source.indexOf('async function saveVideo'),source.indexOf('async function deleteVideo'));
  vm.runInContext(save,h.state);
  const pending=h.state.saveVideo({id:'admin'},false);
  assert.equal(h.state._mediaSaveInProgress,true);assert.equal(h.elements.videoAliyunFileBtn.disabled,true);
  await h.select('second.mp3');assert.equal(h.calls.length,0);assert.match(h.alerts[0],/正在保存/);
  ready();await pending;
  assert.equal(saved.aliyun_vid,'vod-audio');assert.equal(saved.access_type,'paid_membership');assert.equal(saved.is_paid,true);assert.equal(saved.membership_accessible,true);assert.equal(saved.is_published,false);
  assert.equal(saved.source_url,null);assert.equal(saved.mp4_url,null);
  assert.equal(h.state._mediaSaveInProgress,false);assert.equal(h.elements.videoAliyunFileBtn.disabled,false);assert.equal(h.els.videoSave.disabled,false);
});
test('extension must include a dot and a newly uploaded ID clears its old debug URL', async () => {
  assert.ok(validateMediaFile({name:'mp3',size:1}).error);
  const h=harness();h.els.videoAliyunUrl=new Element();h.els.videoAliyunUrl.value='https://example.com/old.mp4';
  await h.select('new.mp3');assert.equal(h.els.videoAliyunUrl.value,'');
});
