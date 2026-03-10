/**
 * ks-voice.js — 语音录入模块
 * 自动为所有 textarea 和 text input 添加麦克风按钮
 * 使用 Web Speech API (SpeechRecognition)，语言默认 zh-CN
 */
(function(){
  'use strict';

  var SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if(!SpeechRecognition) return; // 浏览器不支持则静默退出

  var LANG = 'zh-CN';
  var activeBtn = null; // 当前正在录音的按钮
  var recognition = null;

  function createRecognition(){
    var r = new SpeechRecognition();
    r.lang = LANG;
    r.continuous = true;
    r.interimResults = true;
    r.maxAlternatives = 1;
    return r;
  }

  /** 注入麦克风按钮到目标元素旁边 */
  function injectMicBtn(el){
    if(el.dataset.ksVoice) return; // 已注入
    el.dataset.ksVoice = '1';

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ks-voice-btn';
    btn.setAttribute('aria-label', '语音输入');
    btn.title = '语音输入';
    btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>';

    btn.addEventListener('click', function(e){
      e.preventDefault();
      e.stopPropagation();
      toggleVoice(btn, el);
    });

    // 定位：根据元素类型决定插入位置
    if(el.tagName === 'TEXTAREA'){
      // textarea 上方右侧浮动
      var wrapper = document.createElement('div');
      wrapper.className = 'ks-voice-wrap';
      el.parentNode.insertBefore(wrapper, el);
      wrapper.appendChild(btn);
    } else {
      // input 旁边
      el.style.paddingRight = '36px';
      var container = el.parentNode;
      if(getComputedStyle(container).position === 'static'){
        container.style.position = 'relative';
      }
      container.appendChild(btn);
      btn.classList.add('ks-voice-btn-inline');
    }
  }

  function toggleVoice(btn, target){
    if(activeBtn === btn){
      // 停止录音
      stopVoice();
      return;
    }

    // 如果有其他录音在进行，先停止
    if(activeBtn) stopVoice();

    // 开始录音
    recognition = createRecognition();
    activeBtn = btn;
    btn.classList.add('ks-voice-active');

    var finalTranscript = '';

    recognition.onresult = function(event){
      var interim = '';
      for(var i = event.resultIndex; i < event.results.length; i++){
        if(event.results[i].isFinal){
          finalTranscript += event.results[i][0].transcript;
        } else {
          interim += event.results[i][0].transcript;
        }
      }

      // 写入目标
      if(target.tagName === 'TEXTAREA' || target.tagName === 'INPUT'){
        var before = target.value.substring(0, target.selectionStart || target.value.length);
        var after = target.value.substring(target.selectionEnd || target.value.length);
        target.value = before + finalTranscript + interim + after;
        target.dispatchEvent(new Event('input', {bubbles: true}));
      } else if(target.isContentEditable){
        // contenteditable (KS Editor)
        target.focus();
        document.execCommand('insertText', false, finalTranscript + interim);
        finalTranscript = '';
      }
    };

    recognition.onerror = function(event){
      if(event.error !== 'aborted') console.warn('语音识别错误:', event.error);
      stopVoice();
    };

    recognition.onend = function(){
      // 录音自然结束
      if(activeBtn === btn){
        stopVoice();
      }
    };

    try {
      recognition.start();
    } catch(e){
      console.warn('无法启动语音识别:', e);
      stopVoice();
    }
  }

  function stopVoice(){
    if(recognition){
      try { recognition.stop(); } catch(e){}
      recognition = null;
    }
    if(activeBtn){
      activeBtn.classList.remove('ks-voice-active');
      activeBtn = null;
    }
  }

  /** 扫描页面并注入麦克风按钮 */
  function scan(){
    // textarea（排除隐藏的）
    document.querySelectorAll('textarea.input, textarea.prose-input').forEach(function(el){
      if(el.offsetParent !== null) injectMicBtn(el);
    });
    // text input（排除密码、文件等）
    document.querySelectorAll('input.input[type="text"], input.input:not([type])').forEach(function(el){
      if(el.offsetParent !== null && !el.readOnly && !el.disabled) injectMicBtn(el);
    });
    // 搜索框
    document.querySelectorAll('input[type="search"]').forEach(function(el){
      if(el.offsetParent !== null) injectMicBtn(el);
    });
  }

  // 初始扫描 + MutationObserver 自动检测新增输入框
  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', scan);
  } else {
    scan();
  }

  // 监听 DOM 变化，自动为新增的输入框添加麦克风
  var observer = new MutationObserver(function(mutations){
    var hasNewNodes = mutations.some(function(m){ return m.addedNodes.length > 0; });
    if(hasNewNodes) scan();
  });
  observer.observe(document.body || document.documentElement, { childList: true, subtree: true });

  // 暴露 API
  window.ksVoice = { scan: scan, stop: stopVoice };
})();
