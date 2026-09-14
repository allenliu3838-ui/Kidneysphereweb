import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const read = name => readFileSync(new URL('../' + name, import.meta.url), 'utf8');
const { validateMediaFile, MEDIA_ACCEPT, MAX_MEDIA_BYTES } = await import('data:text/javascript;base64,' + Buffer.from(read('media-upload.js')).toString('base64'));
const source = read('learning-center.js');
const setup = source.slice(source.indexOf('function setupAliyunDirectUpload()'), source.indexOf('function setupBatchUpload('));
const save = source.slice(source.indexOf('async function saveVideo'), source.indexOf('async function deleteVideo'));
const setupBatch = source.slice(source.indexOf('function setupBatchUpload('), source.indexOf('// Run after DOM is ready'));
class Element {
  constructor() { this.dataset={};this.style={};this.value='';this.disabled=false;this.files=[];this.listeners={};this.textContent='';this.selectedOptions=[]; }
  addEventListener(event, listener) { this.listeners[event]=listener; }
  click() { return this.listeners.click?.(); }
  contains() { return false; }
}
function deferred() { let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject}; }
function harness({fail=false,onUpload,initialVid=''}={}) {
  const ids=['videoAliyunFile','videoAliyunFileBtn','videoAliyunCancelBtn','videoAliyunFileStatus','videoAliyunUploadProgress','videoAliyunUploadBar','videoAliyunUploadText','videoAliyunVid','videoTitle','mediaBatchPanel','videoAddForm'];
  const elements=Object.fromEntries(ids.map(id=>[id,new Element()]));
  elements.videoAliyunVid.value=initialVid;
  const els={videoSave:new Element(),videoSaveDraft:new Element(),videoSourceType:new Element()};
  const calls=[],alerts=[],toasts=[];
  const state={
    document:{getElementById:id=>elements[id],querySelectorAll:()=>[]},window:{addEventListener(){}},els,validateMediaFile,AbortController,
    alert:message=>alerts.push(message),toast:(...args)=>toasts.push(args),console:{error(){}},
    _currentUpload:null,_mediaSaveInProgress:false,_batchBusy:false,supabase:{},
    vodUploader:()=>async(file,options)=>{
      calls.push({file,...options});options.onStatus?.('正在获取上传凭证…');
      await onUpload?.(elements,els,options);
      if(options.signal.aborted){const error=new Error('cancelled');error.name='AbortError';throw error;}
      if(fail)throw new Error('network interrupted');
      options.onProgress?.(1);return {videoId:'test-vod-id'};
    }
  };
  vm.createContext(state);vm.runInContext(setup+'\nsetupAliyunDirectUpload();',state);
  return {elements,els,calls,alerts,toasts,state,async select(name,size=10){elements.videoAliyunFile.files=[{name,size}];return elements.videoAliyunFile.listeners.change();}};
}
function prepareSave(h,{ensure=Promise.resolve(),insert=async()=>({error:null})}={}) {
  Object.assign(h.els,{videoTitle:h.elements.videoTitle,videoAliyunVid:h.elements.videoAliyunVid,videoCategory:new Element(),videoAccessType:new Element(),videoAliyunUrl:new Element()});
  h.elements.videoTitle.value='会员音频';h.elements.videoAliyunVid.value='vod-audio';
  h.els.videoCategory.value='glom';h.els.videoSourceType.value='aliyun_vod';h.els.videoAccessType.value='paid_membership';h.els.videoAliyunUrl.value='https://example.com/old.mp4';
  Object.assign(h.state,{isConfigured:()=>true,ensureSupabase:()=>ensure,looksLikeHtml:()=>false,getCheckedSpecialtyIds:()=>[],loadAdminVideos:async()=>{}});
  h.state.supabase.from=()=>({insert});vm.runInContext(save,h.state);
}
test('supports official audio extensions, case-insensitive, and all previously accepted video formats',()=>{
  for(const ext of ['mp3','M4A','wav','aac','flac','wma','ape']){
    assert.equal(validateMediaFile({name:'教学.'+ext,size:10}).mediaType,'audio');assert.ok(MEDIA_ACCEPT.includes('.'+ext.toLowerCase()));
  }
  for(const ext of ['mp4','mov','m4v','mkv','avi','flv','wmv','webm','ts'])assert.equal(validateMediaFile({name:'lecture.'+ext,size:10}).mediaType,'video');
});
test('blocks disguised, empty, oversized and unknown files before invoking VOD transport',async()=>{
  for(const [name,size] of [['voice.mp3.exe',5],['voice.ogg',5],['voice.mp3',0],['voice.mp3',MAX_MEDIA_BYTES+1]]){
    const h=harness();await h.select(name,size);assert.equal(h.calls.length,0);assert.equal(h.alerts.length,1);
  }
  assert.equal(validateMediaFile({name:'lecture.mp3',size:MAX_MEDIA_BYTES}).mediaType,'audio');
});
for(const ext of ['MP3','M4A'])test(ext+' delegates to shared VOD uploader and fills existing course fields',async()=>{
  const h=harness({onUpload:(elements,els,options)=>{
    assert.equal(els.videoSave.disabled,true);assert.equal(els.videoSaveDraft.disabled,true);assert.equal(els.videoSourceType.disabled,true);
    assert.equal(elements.mediaBatchPanel.disabled,true);assert.equal(elements.videoAliyunFileBtn.disabled,true);assert.equal(options.signal.aborted,false);
  }});
  await h.select('临床学习.'+ext);
  assert.equal(h.calls.length,1);assert.equal(h.calls[0].file.name,'临床学习.'+ext);assert.equal(h.calls[0].title,'临床学习');assert.ok(h.calls[0].signal instanceof AbortSignal);
  assert.equal(h.elements.videoAliyunVid.value,'test-vod-id');assert.equal(h.elements.videoTitle.value,'临床学习');
  assert.match(h.elements.videoAliyunUploadText.textContent,/音频上传成功/);assert.equal(h.els.videoSave.disabled,false);
  assert.equal(h.elements.mediaBatchPanel.disabled,false);assert.equal(h.state._currentUpload,null);
});
test('existing MP4 uses same shared transport and preserves manually entered title',async()=>{
  const h=harness();h.elements.videoTitle.value='手工课程标题';await h.select('clinical.mp4');
  assert.equal(h.calls.length,1);assert.equal(h.calls[0].title,'手工课程标题');assert.equal(h.elements.videoTitle.value,'手工课程标题');assert.match(h.elements.videoAliyunUploadText.textContent,/视频上传成功/);
});
test('cancel aborts shared transport without erasing previous media ID',async()=>{
  const h=harness({initialVid:'previous-course',onUpload:async elements=>{await elements.videoAliyunCancelBtn.click();}});
  await h.select('new.mp3');assert.equal(h.calls.length,1);assert.equal(h.calls[0].signal.aborted,true);
  assert.equal(h.elements.videoAliyunVid.value,'previous-course');assert.match(h.elements.videoAliyunUploadText.textContent,/已停止/);
  assert.equal(h.els.videoSave.disabled,false);assert.equal(h.elements.mediaBatchPanel.disabled,false);assert.equal(h.elements.videoAliyunCancelBtn.style.display,'none');assert.equal(h.state._currentUpload,null);
});
test('upload failure preserves previous ID and each pre-existing disabled state',async()=>{
  const h=harness({fail:true,initialVid:'previous-course'});h.els.videoSaveDraft.disabled=true;h.elements.mediaBatchPanel.disabled=true;
  await h.select('new.wav');assert.equal(h.elements.videoAliyunVid.value,'previous-course');assert.equal(h.els.videoSave.disabled,false);
  assert.equal(h.els.videoSaveDraft.disabled,true);assert.equal(h.elements.mediaBatchPanel.disabled,true);assert.match(h.elements.videoAliyunUploadText.textContent,/上传失败/);assert.equal(h.state._currentUpload,null);
});
test('VOD saving keeps access metadata and fails closed on schema errors',async()=>{
  assert.match(save,/sourceType !== 'aliyun_vod' && \/access_type/);assert.doesNotMatch(save,/delete row\.aliyun_vid/);
  const h=harness(),rows=[];
  prepareSave(h,{insert:async row=>{rows.push(JSON.parse(JSON.stringify(row)));return {error:{message:'column access_type does not exist'}};}});
  await h.state.saveVideo({id:'admin'},false);
  assert.equal(rows.length,1,'VOD schema errors must not retry a less protected insert');
  assert.equal(rows[0].aliyun_vid,'vod-audio');assert.equal(rows[0].access_type,'paid_membership');assert.equal(rows[0].membership_accessible,true);
  assert.equal(h.elements.videoAliyunVid.value,'vod-audio');assert.equal(h.toasts.at(-1)[0],'保存失败');assert.equal(h.state._mediaSaveInProgress,false);
});
test('save in flight blocks second upload and keeps VOD access fields intact',async()=>{
  const h=harness(),held=deferred();let saved;
  prepareSave(h,{ensure:held.promise,insert:async row=>{saved=JSON.parse(JSON.stringify(row));return {error:null};}});
  const pending=h.state.saveVideo({id:'admin'},false);
  assert.equal(h.state._mediaSaveInProgress,true);assert.equal(h.elements.videoAliyunFileBtn.disabled,true);assert.equal(h.elements.mediaBatchPanel.disabled,true);
  await h.select('second.mp3');assert.equal(h.calls.length,0);assert.match(h.alerts[0],/正在保存/);held.resolve();await pending;
  assert.equal(saved.aliyun_vid,'vod-audio');assert.equal(saved.access_type,'paid_membership');assert.equal(saved.is_paid,true);assert.equal(saved.membership_accessible,true);assert.equal(saved.is_published,false);
  assert.equal(saved.source_url,null);assert.equal(saved.mp4_url,null);assert.equal(h.state._mediaSaveInProgress,false);
  assert.equal(h.elements.videoAliyunFileBtn.disabled,false);assert.equal(h.elements.mediaBatchPanel.disabled,false);assert.equal(h.els.videoSave.disabled,false);
});
test('batch busy blocks single upload and single save before transport or database writes',async()=>{
  const h=harness();let inserted=0;
  prepareSave(h,{insert:async()=>{inserted++;return {error:null};}});h.state._batchBusy=true;
  await h.select('single.mp3');await h.state.saveVideo({id:'admin'},false);
  assert.equal(h.calls.length,0);assert.equal(inserted,0);assert.match(h.alerts[0],/批量上传/);assert.equal(h.toasts.at(-1)[0],'批量上传正在处理');
  assert.equal(h.elements.videoAliyunVid.value,'vod-audio');assert.equal(h.state._mediaSaveInProgress,false);
});
test('active single upload blocks course saving until final media ID is known',async()=>{
  const held=deferred(),h=harness({onUpload:()=>held.promise});let inserted=0;
  prepareSave(h,{insert:async()=>{inserted++;return {error:null};}});
  const pending=h.select('single.mp3');await h.state.saveVideo({id:'admin'},false);
  assert.equal(inserted,0);assert.equal(h.toasts.at(-1)[0],'文件正在上传');assert.equal(h.state._mediaSaveInProgress,false);
  held.resolve();await pending;assert.equal(h.elements.videoAliyunVid.value,'test-vod-id');
});
test('batch settings reject active single operations and shared form locks restore original states',()=>{
  const h=harness();let options;prepareSave(h);h.els.videoSourceType.disabled=true;
  const controls=[h.els.videoSave,h.els.videoSourceType,h.elements.videoAliyunFileBtn];
  h.elements.videoAddForm.querySelectorAll=()=>controls;
  Object.assign(h.state,{BatchQueue:class{},saveBatchCourse(){},_specialtiesMap:{},mountBatchUpload:(_,value)=>{options=value;return {refreshSettings(){}};}});
  vm.runInContext(setupBatch+'\nsetupBatchUpload({id:"admin"});',h.state);
  h.state._mediaSaveInProgress=true;assert.throws(()=>options.getSettings(),/单个文件/);
  h.state._mediaSaveInProgress=false;h.state._currentUpload=new AbortController();assert.throws(()=>options.getSettings(),/单个文件/);
  h.state._currentUpload=null;options.onBusy(true);assert.equal(h.state._batchBusy,true);assert.ok(controls.every(control=>control.disabled));
  options.onBusy(false);assert.equal(h.state._batchBusy,false);assert.equal(h.els.videoSave.disabled,false);assert.equal(h.els.videoSourceType.disabled,true);assert.equal(h.elements.videoAliyunFileBtn.disabled,false);
});
test('extension needs a dot and newly uploaded ID clears old debug URL',async()=>{
  assert.ok(validateMediaFile({name:'mp3',size:1}).error);
  const h=harness();h.els.videoAliyunUrl=new Element();h.els.videoAliyunUrl.value='https://example.com/old.mp4';
  await h.select('new.mp3');assert.equal(h.els.videoAliyunUrl.value,'');
});
