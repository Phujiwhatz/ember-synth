// Minimal JSON value + parser/serializer (enough for plugin state and patches).
#pragma once
#include <string>
#include <vector>
#include <map>
#include <memory>
#include <cstdlib>
#include <cstdio>

namespace ember {
struct Json {
    enum T { Null, Bool, Num, Str, Arr, Obj } t = Null;
    double n = 0; bool b = false; std::string s;
    std::vector<Json> a; std::map<std::string, Json> o;
    Json() = default;
    Json(double v) : t(Num), n(v) {}
    Json(const std::string& v) : t(Str), s(v) {}
    Json(const char* v) : t(Str), s(v) {}
    bool isNum() const { return t == Num || t == Bool; }
    double num(double def = 0) const { return t == Num ? n : (t == Bool ? (b ? 1 : 0) : def); }
    const std::string& str() const { return s; }
    bool has(const std::string& k) const { return t == Obj && o.count(k); }
    const Json& operator[](const std::string& k) const { static Json nul; auto it = o.find(k); return (t == Obj && it != o.end()) ? it->second : nul; }
    const Json& operator[](size_t i) const { static Json nul; return (t == Arr && i < a.size()) ? a[i] : nul; }

    static Json parse(const std::string& src) { size_t i = 0; Json j; parseVal(src, i, j); return j; }
    std::string dump() const { std::string out; dumpTo(out); return out; }

  private:
    static void ws(const std::string& s, size_t& i) { while (i < s.size() && (s[i] == ' ' || s[i] == '\n' || s[i] == '\r' || s[i] == '\t')) ++i; }
    static bool parseVal(const std::string& s, size_t& i, Json& j) {
        ws(s, i); if (i >= s.size()) return false; char c = s[i];
        if (c == '{') { j.t = Obj; ++i; ws(s, i); if (i < s.size() && s[i] == '}') { ++i; return true; }
            while (i < s.size()) { ws(s, i); Json k; if (!parseVal(s, i, k)) return false; ws(s, i); if (i >= s.size() || s[i] != ':') return false; ++i;
                Json v; if (!parseVal(s, i, v)) return false; j.o[k.s] = std::move(v); ws(s, i);
                if (i < s.size() && s[i] == ',') { ++i; continue; } if (i < s.size() && s[i] == '}') { ++i; return true; } return false; }
            return false; }
        if (c == '[') { j.t = Arr; ++i; ws(s, i); if (i < s.size() && s[i] == ']') { ++i; return true; }
            while (i < s.size()) { Json v; if (!parseVal(s, i, v)) return false; j.a.push_back(std::move(v)); ws(s, i);
                if (i < s.size() && s[i] == ',') { ++i; continue; } if (i < s.size() && s[i] == ']') { ++i; return true; } return false; }
            return false; }
        if (c == '"') { j.t = Str; ++i; std::string out;
            while (i < s.size() && s[i] != '"') {
                if (s[i] == '\\' && i + 1 < s.size()) { char e = s[++i];
                    if (e == 'n') out += '\n'; else if (e == 't') out += '\t'; else if (e == 'r') out += '\r'; else if (e == 'b') out += '\b'; else if (e == 'f') out += '\f';
                    else if (e == 'u' && i + 4 < s.size()) { unsigned cp = (unsigned)strtoul(s.substr(i + 1, 4).c_str(), nullptr, 16); i += 4;
                        if (cp >= 0xD800 && cp <= 0xDBFF && i + 6 < s.size() && s[i + 1] == '\\' && s[i + 2] == 'u') { unsigned lo = (unsigned)strtoul(s.substr(i + 3, 4).c_str(), nullptr, 16); cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00); i += 6; }
                        if (cp < 0x80) out += (char)cp; else if (cp < 0x800) { out += (char)(0xC0 | (cp >> 6)); out += (char)(0x80 | (cp & 63)); }
                        else if (cp < 0x10000) { out += (char)(0xE0 | (cp >> 12)); out += (char)(0x80 | ((cp >> 6) & 63)); out += (char)(0x80 | (cp & 63)); }
                        else { out += (char)(0xF0 | (cp >> 18)); out += (char)(0x80 | ((cp >> 12) & 63)); out += (char)(0x80 | ((cp >> 6) & 63)); out += (char)(0x80 | (cp & 63)); } }
                    else out += e; ++i; }
                else out += s[i++]; }
            ++i; j.s = out; return true; }
        if (s.compare(i, 4, "true") == 0) { j.t = Bool; j.b = true; i += 4; return true; }
        if (s.compare(i, 5, "false") == 0) { j.t = Bool; j.b = false; i += 5; return true; }
        if (s.compare(i, 4, "null") == 0) { j.t = Null; i += 4; return true; }
        char* end = nullptr; j.n = strtod(s.c_str() + i, &end); if (end == s.c_str() + i) return false; j.t = Num; i = end - s.c_str(); return true;
    }
    static void esc(const std::string& in, std::string& out) {
        out += '"'; for (unsigned char c : in) { if (c == '"') out += "\\\""; else if (c == '\\') out += "\\\\"; else if (c == '\n') out += "\\n"; else if (c < 0x20) { char b[8]; snprintf(b, 8, "\\u%04x", c); out += b; } else out += (char)c; } out += '"';
    }
    void dumpTo(std::string& out) const {
        switch (t) {
            case Null: out += "null"; break; case Bool: out += b ? "true" : "false"; break;
            case Num: { char b2[32]; snprintf(b2, 32, "%.10g", n); out += b2; break; }
            case Str: esc(s, out); break;
            case Arr: out += '['; for (size_t i = 0; i < a.size(); ++i) { if (i) out += ','; a[i].dumpTo(out); } out += ']'; break;
            case Obj: { out += '{'; bool f = true; for (auto& kv : o) { if (!f) out += ','; f = false; esc(kv.first, out); out += ':'; kv.second.dumpTo(out); } out += '}'; break; }
        }
    }
};
} // namespace ember
