// Renders every factory patch through the C++ engine and compares loudness with the browser version.
#include "../core/engine.h"
#include <fstream>
#include <sstream>
#include <iostream>
#include <regex>
using namespace ember;
static std::string slurp(const char* p) { std::ifstream f(p); std::stringstream s; s << f.rdbuf(); return s.str(); }
int main(int argc, char** argv) {
    Json all = Json::parse(slurp("tests/presets.json"));
    Json web = Json::parse(slurp(argc > 1 ? argv[1] : "/tmp/studio_levels.json"));
    const double sr = 48000; const int N = (int)(sr * 3), B = 512;
    std::cout.setf(std::ios::fixed); std::cout.precision(3);
    for (auto& inst : {"ember", "fm", "wt", "organ", "strings"}) {
        const Json& I = all[inst]; std::vector<double> diffs; int bad = 0, silent = 0, clip = 0; std::string worst; double worstD = 0;
        for (auto& pr : I["presets"].a) {
            Engine e; e.prepare(sr, B);
            Json st = Json::parse("{\"mode\":\"single\",\"slots\":[{},{}]}");
            st.o["slots"].a[0].o["instr"] = Json(std::string(inst)); st.o["slots"].a[0].o["P"] = pr["p"];
            st.o["slots"].a[1].o["instr"] = Json("strings"); st.o["slots"].a[1].o["P"] = all["strings"]["base"];
            e.setState(st);
            const Params P = Params::fromJson(pr["p"]); std::string cat = pr["cat"].str(), name = pr["name"].str();
            bool mono = P.str("playMode", "poly") != "poly";
            bool bassy = cat == "Bass" || name.find("Bass") != std::string::npos || name.find("Pedal") != std::string::npos;
            std::vector<int> notes = mono ? std::vector<int>{(cat == "Bass" || name.find("Bass") != std::string::npos) ? 40 : 60} : (bassy ? std::vector<int>{36, 48} : std::vector<int>{48, 60, 64, 67});
            for (int nn : notes) { uint8_t m[3] = {0x90, (uint8_t)nn, 100}; e.midi(m, 3); }
            if (P("pressAmp", 0.3) > 0.6) { uint8_t m[2] = {0xD0, (uint8_t)(0.7 * 127)}; e.midi(m, 2); }
            std::vector<float> L(N), R(N); bool off = false;
            for (int i = 0; i < N; i += B) {
                if (!off && i >= (int)(2 * sr)) { for (int nn : notes) { uint8_t m[3] = {0x80, (uint8_t)nn, 0}; e.midi(m, 3); } off = true; }
                e.process(&L[i], &R[i], std::min(B, N - i));
            }
            double pk = 0, mx = 0; bool nan = false;
            for (int i = 0; i < N; i += 12000) { double s = 0; int c = 0; for (int j = i; j < i + 12000 && j < N; ++j) { if (!std::isfinite(L[j])) nan = true; s += L[j] * L[j]; pk = std::max(pk, (double)std::fabs(L[j])); ++c; } mx = std::max(mx, std::sqrt(s / 12000)); }
            if (nan) ++bad; if (mx < 0.004) ++silent; if (pk > 1.01) ++clip;
            double w = web[inst][name]["rms"].num(0);
            if (w > 0 && mx > 0) { double d = 20 * std::log10(mx / w); diffs.push_back(d); if (std::fabs(d) > std::fabs(worstD)) { worstD = d; worst = name; } }
        }
        std::sort(diffs.begin(), diffs.end());
        double med = diffs.empty() ? 0 : diffs[diffs.size() / 2]; int within3 = 0; for (double d : diffs) if (std::fabs(d - med) < 3 && std::fabs(d) < 4) ++within3;
        std::cout << inst << "\tpatches " << I["presets"].a.size() << "  broken " << bad << "  silent " << silent << "  clipping " << clip
                  << "  | loudness vs web: median " << med << " dB, range " << (diffs.empty() ? 0 : diffs.front()) << ".." << (diffs.empty() ? 0 : diffs.back())
                  << " dB, within ±4 dB: " << within3 << "/" << diffs.size() << "  worst: " << worst << " (" << worstD << " dB)\n";
    }
}
