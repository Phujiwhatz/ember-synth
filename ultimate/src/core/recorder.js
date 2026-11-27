/* Ember Ultimate — bounce recorder: captures the master output and downloads a 16-bit stereo WAV. */
(function () {
  'use strict';
  var Studio = window.Studio;
  var R = Studio.recorder = { recording: false, seconds: 0, chunksL: [], chunksR: [], frames: 0 };
  var node = null, sink = null, mode = null, readyP = null;

  var WORKLET = 'class EuRec extends AudioWorkletProcessor{constructor(){super();this.on=false;this.port.onmessage=e=>{this.on=e.data==="start"}}' +
    'process(inp){const i=inp[0];if(this.on&&i&&i.length){const l=i[0],r=i[1]||i[0];this.port.postMessage([l.slice(0),r.slice(0)])}return true}}' +
    'registerProcessor("eu-rec",EuRec);';

  function setup() {
    if (readyP) return readyP;
    var ctx = Studio.ctx, out = Studio.mixer.master.out;
    sink = ctx.createGain(); sink.gain.value = 0; sink.connect(ctx.destination);
    readyP = Promise.resolve().then(function () {
      if (!ctx.audioWorklet || typeof AudioWorkletNode === 'undefined') throw new Error('no worklet');
      var dataUrl = 'data:application/javascript;charset=utf-8,' + encodeURIComponent(WORKLET);
      var blobUrl = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
      var first = location.protocol === 'file:' ? dataUrl : blobUrl, second = first === dataUrl ? blobUrl : dataUrl;
      return ctx.audioWorklet.addModule(first).catch(function () { return ctx.audioWorklet.addModule(second); }).then(function () {
        node = new AudioWorkletNode(ctx, 'eu-rec', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit' });
        node.port.onmessage = function (e) { push(e.data[0], e.data[1]); };
        mode = 'worklet';
      });
    }).catch(function () {
      node = ctx.createScriptProcessor(4096, 2, 2);
      node.onaudioprocess = function (e) {
        if (!R.recording) return;
        var b = e.inputBuffer;
        push(new Float32Array(b.getChannelData(0)), new Float32Array(b.getChannelData(b.numberOfChannels > 1 ? 1 : 0)));
      };
      mode = 'script';
    }).then(function () {
      out.connect(node); node.connect(sink);
    });
    return readyP;
  }
  function push(l, r) {
    if (!R.recording) return;
    R.chunksL.push(l); R.chunksR.push(r); R.frames += l.length;
    R.seconds = R.frames / Studio.ctx.sampleRate;
  }

  R.start = function () {
    if (R.recording || !Studio.ctx) return Promise.resolve();
    return setup().then(function () {
      R.chunksL = []; R.chunksR = []; R.frames = 0; R.seconds = 0;
      R.recording = true;
      if (mode === 'worklet') node.port.postMessage('start');
      Studio._emit('record', true);
    });
  };
  R.stop = function () {
    if (!R.recording) return null;
    R.recording = false;
    if (mode === 'worklet') node.port.postMessage('stop');
    Studio._emit('record', false);
    if (!R.frames) { Studio.toast('Nothing recorded'); return null; }
    var blob = R.encode(R.chunksL, R.chunksR, Studio.ctx.sampleRate);
    R.chunksL = []; R.chunksR = [];
    var d = new Date(), pad = function (n) { return (n < 10 ? '0' : '') + n; };
    var name = 'ember-bounce-' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds()) + '.wav';
    Studio._download(blob, name);
    Studio.toast('Bounced ' + R.seconds.toFixed(1) + ' s → ' + name);
    R.lastBlob = blob;
    return blob;
  };
  R.toggle = function () { return R.recording ? R.stop() : R.start(); };

  /* 16-bit PCM WAV, TPDF-dithered */
  R.encode = function (L, Rc, sr) {
    var n = 0, i; for (i = 0; i < L.length; i++) n += L[i].length;
    var buf = new ArrayBuffer(44 + n * 4), v = new DataView(buf);
    function str(o, s) { for (var k = 0; k < s.length; k++) v.setUint8(o + k, s.charCodeAt(k)); }
    str(0, 'RIFF'); v.setUint32(4, 36 + n * 4, true); str(8, 'WAVE');
    str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 2, true);
    v.setUint32(24, sr, true); v.setUint32(28, sr * 4, true); v.setUint16(32, 4, true); v.setUint16(34, 16, true);
    str(36, 'data'); v.setUint32(40, n * 4, true);
    var o = 44;
    for (i = 0; i < L.length; i++) {
      var l = L[i], r = Rc[i];
      for (var j = 0; j < l.length; j++) {
        var a = l[j] * 32767 + (Math.random() - Math.random()), b = r[j] * 32767 + (Math.random() - Math.random());
        v.setInt16(o, a > 32767 ? 32767 : a < -32768 ? -32768 : a | 0, true);
        v.setInt16(o + 2, b > 32767 ? 32767 : b < -32768 ? -32768 : b | 0, true);
        o += 4;
      }
    }
    return new Blob([buf], { type: 'audio/wav' });
  };
})();
