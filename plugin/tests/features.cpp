#include "../core/engine.h"
#include <fstream>
#include <sstream>
#include <iostream>
namespace ember { struct Tests {
  static std::string slurp(const char* p) { std::ifstream f(p); std::stringstream s; s << f.rdbuf(); return s.str(); }
  static void run() {
    Json all = Json::parse(slurp("tests/presets.json"));
    auto preset = [&](const char* inst, const char* name) { for (auto& p : all[inst]["presets"].a) if (p["name"].str() == name) return p["p"]; return all[inst]["base"]; };
    auto state = [&](const char* mode, const char* ia, Json pa, const char* ib, Json pb, int split = 60) {
      Json st = Json::parse("{\"slots\":[{},{}]}"); st.o["mode"] = Json(mode); st.o["splitNote"] = Json((double)split);
      st.o["slots"].a[0].o["instr"] = Json(ia); st.o["slots"].a[0].o["P"] = pa; st.o["slots"].a[1].o["instr"] = Json(ib); st.o["slots"].a[1].o["P"] = pb; return st; };
    auto on = [](Engine& e, int k, int ch = 0) { uint8_t m[3] = {(uint8_t)(0x90 | ch), (uint8_t)k, 100}; e.midi(m, 3); };
    auto off = [](Engine& e, int k, int ch = 0) { uint8_t m[3] = {(uint8_t)(0x80 | ch), (uint8_t)k, 0}; e.midi(m, 3); };
    auto run = [](Engine& e, double sec) { std::vector<float> L(512), R(512); for (int i = 0; i < (int)(sec * 48000); i += 512) e.process(L.data(), R.data(), 512); };
    auto live = [](Slot& s) { int n = 0; for (auto& v : s.voices) if (!v->rel) ++n; return n; };
    { Engine e; e.prepare(48000, 512); e.setState(state("layer", "ember", preset("ember", "Velvet Pad"), "strings", preset("strings", "Solina Classic")));
      on(e, 60); run(e, 0.1); std::cout << "layer:   A voices " << live(e.slots[0]) << ", B voices " << live(e.slots[1]) << "  (want 1, 1)\n"; }
    { Engine e; e.prepare(48000, 512); e.setState(state("split", "ember", preset("ember", "Velvet Pad"), "fm", preset("fm", "Lately Bass"), 60));
      on(e, 48); on(e, 72); run(e, 0.1); std::cout << "split:   A voices " << live(e.slots[0]) << ", B voices " << live(e.slots[1]) << "  (want 1, 1)\n"; }
    { Engine e; e.prepare(48000, 512); e.setState(state("single", "fm", preset("fm", "Rubber FM Bass"), "strings", all["strings"]["base"]));
      on(e, 40); run(e, 0.3); on(e, 43); run(e, 0.03); auto& v = *e.slots[0].voices.back();
      std::cout << "legato:  voices " << live(e.slots[0]) << " (want 1), note " << v.note << " (want 43), gliding " << (v.glideCents != 0 ? "yes" : "no") << " (want yes)\n"; }
    { Engine e; e.prepare(48000, 512); e.setState(state("single", "ember", preset("ember", "Berlin Sequence"), "strings", all["strings"]["base"]));
      std::vector<std::pair<double,int>> starts; on(e, 60); on(e, 64); on(e, 67);
      std::vector<float> L(32), R(32); size_t seen = 0;
      for (int i = 0; i < 48000 * 1.6 / 32; ++i) { e.process(L.data(), R.data(), 32); auto& vs = e.slots[0].voices; for (auto& v : vs) if (v->age < 32 / 48000.0 + 1e-9) starts.push_back({e.now, v->note}); }
      std::cout << "arp:     "; double prev = -1; std::vector<double> gaps; for (auto& s : starts) { std::cout << s.second << " "; if (prev >= 0) gaps.push_back(s.first - prev); prev = s.first; }
      double mx = 0, mn = 9; for (double g : gaps) { mx = std::max(mx, g); mn = std::min(mn, g); } std::cout << "| step gaps " << mn << ".." << mx << " s (want 0.125)\n"; }
    { Engine e; e.prepare(48000, 512); e.setState(state("single", "organ", preset("organ", "Jimmy Smith"), "strings", all["strings"]["base"]));
      on(e, 60, 1); on(e, 64, 2); run(e, 0.05); uint8_t b[3] = {0xE1, 0x7F, 0x7F}; e.midi(b, 3); uint8_t p[2] = {0xD2, 100}; e.midi(p, 2); run(e, 0.1);
      double b1 = 0, b2 = 0, p1 = 0, p2 = 0; for (auto& v : e.slots[0].voices) { if (v->ch == 1) { b1 = v->bendS.v; p1 = v->pressS.v; } if (v->ch == 2) { b2 = v->bendS.v; p2 = v->pressS.v; } }
      std::cout << "MPE:     ch2 note bend " << b1 << "¢ (want ~4800), ch3 note bend " << b2 << " (want 0); pressure ch2 " << p1 << " (want 0), ch3 " << p2 << " (want ~0.79)\n"; }
    { Engine e; e.prepare(48000, 512); e.setState(state("single", "strings", preset("strings", "Solina Classic"), "strings", all["strings"]["base"]));
      uint8_t sd[3] = {0xB0, 64, 127}; e.midi(sd, 3); on(e, 60); run(e, 0.1); off(e, 60); run(e, 0.1); int held = live(e.slots[0]);
      uint8_t su[3] = {0xB0, 64, 0}; e.midi(su, 3); run(e, 0.05); std::cout << "sustain: held while pedal down " << held << " (want 1), after pedal up " << live(e.slots[0]) << " (want 0)\n"; }
    { Engine e; e.prepare(48000, 512); e.setState(state("single", "ember", preset("ember", "Velvet Pad"), "strings", all["strings"]["base"]));
      on(e, 60); run(e, 0.1); e.setState(state("single", "wt", preset("wt", "Prism Pad"), "strings", all["strings"]["base"])); on(e, 62); run(e, 0.1);
      std::cout << "switch:  instrument now " << e.slots[0].instr << ", voices " << live(e.slots[0]) << " (want wt, 1)\n"; }
  } }; }
int main() { ember::Tests::run(); }
