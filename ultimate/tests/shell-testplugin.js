/* Throwaway plugin used only by tests/shell-test.js when src/plugins/ is empty. */
(function () {
  var voices = {}, out, ctx;
  Studio.registerPlugin({
    id: 'shelltest', name: 'Test Tone', kind: 'instrument', color: '#5fd38a',
    init: function (c, o) { ctx = c; out = o; },
    mount: function (el) { el.innerHTML = '<div style="padding:40px;color:#ccc;font:16px sans-serif">Test Tone plugin</div>'; },
    noteOn: function (n, v, t) {
      var osc = ctx.createOscillator(), g = ctx.createGain();
      osc.type = 'sawtooth'; osc.frequency.value = 440 * Math.pow(2, (n - 69) / 12);
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(v * 0.3, t + 0.01);
      osc.connect(g).connect(out); osc.start(t); voices[n] = { osc: osc, g: g };
    },
    noteOff: function (n, t) { var x = voices[n]; if (!x) return; x.g.gain.setTargetAtTime(0, t, 0.05); x.osc.stop(t + 0.5); delete voices[n]; },
    allNotesOff: function () { Object.keys(voices).forEach(function (n) { voices[n].osc.stop(); }); voices = {}; },
    getState: function () { return {}; }, setState: function () {}
  });
})();
