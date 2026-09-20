// quantize_gguf: rewrite a GGUF file quantizing whitelisted F32 tensors.
// Produces public/models/muscriptor/muscriptor-small-q8_0.gguf from the f32 file.
// Only tensors loaded with a storage type in decoder.cpp's load_weights may be
// quantized; embeddings, norms and biases must stay f32.
//
// Build (needs a native audio.cpp build for libggml):
//   c++ -O2 -std=c++17 -I$AUDIOCPP/external/ggml/include \
//     -o quantize_gguf wasm/quantize_gguf.cpp \
//     $AUDIOCPP/build/ggml/src/libggml{,-cpu,-base}.a -framework Accelerate
//
// Usage: quantize_gguf <in.gguf> <out.gguf> <q8_0|q4_0> <name1> [name2 ...]
// Names: condition_provider.conditioners.self_wav.output_proj.weight,
//   linears.0.weight, and transformer.layers.{0..13}.{self_attn.in_proj_weight,
//   self_attn.out_proj.weight,linear1.weight,linear2.weight}
// Metadata kvs are copied verbatim; tensor infos get new type/offsets.
#include "ggml.h"
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <string>
#include <unordered_set>
#include <vector>

static uint32_t rd32(const uint8_t *& p) { uint32_t v; memcpy(&v, p, 4); p += 4; return v; }
static uint64_t rd64(const uint8_t *& p) { uint64_t v; memcpy(&v, p, 8); p += 8; return v; }

static size_t type_fixed_size(uint32_t t) {
    switch (t) {
        case 0: case 1: case 7: return 1;   // u8 i8 bool
        case 2: case 3: return 2;           // u16 i16
        case 4: case 5: case 6: return 4;   // u32 i32 f32
        case 10: case 11: case 12: return 8;// u64 i64 f64
    }
    fprintf(stderr, "bad kv type %u\n", t); exit(1);
}

// returns bytes consumed by a kv value of type t at p (p not advanced)
static size_t kv_value_size(const uint8_t * p) {
    uint32_t t; memcpy(&t, p, 4); p += 4;
    if (t == 8) { uint64_t n; memcpy(&n, p, 8); return 4 + 8 + n; }        // string
    if (t == 9) {                                                          // array
        uint32_t et; uint64_t n; memcpy(&et, p, 4); memcpy(&n, p + 4, 8); p += 12;
        size_t total = 16;
        for (uint64_t i = 0; i < n; ++i) {
            if (et == 8) { uint64_t m; memcpy(&m, p, 8); total += 8 + m; p += 8 + m; }
            else if (et == 9) { fprintf(stderr, "nested arrays unsupported\n"); exit(1); }
            else { size_t s = type_fixed_size(et); total += s; p += s; }
        }
        return total;
    }
    return 4 + type_fixed_size(t);
}

int main(int argc, char ** argv) {
    if (argc < 4) { fprintf(stderr, "usage: in out q8_0|q4_0 [names...]\n"); return 1; }
    const char * in_path = argv[1];
    const char * out_path = argv[2];
    const std::string ts = argv[3];
    const ggml_type qtype = ts == "q4_0" ? GGML_TYPE_Q4_0 : GGML_TYPE_Q8_0;
    std::unordered_set<std::string> whitelist;
    for (int i = 4; i < argc; ++i) whitelist.insert(argv[i]);

    std::ifstream in(in_path, std::ios::binary);
    std::vector<uint8_t> buf((std::istreambuf_iterator<char>(in)), {});
    const uint8_t * p = buf.data();
    if (rd32(p) != 0x46554747) { fprintf(stderr, "not gguf\n"); return 1; }
    uint32_t ver = rd32(p);
    uint64_t ntensors = rd64(p), nkv = rd64(p);
    if (ver != 3) { fprintf(stderr, "gguf v%u unsupported\n", ver); return 1; }

    const uint8_t * kv_begin = p;
    uint32_t alignment = 32;
    for (uint64_t i = 0; i < nkv; ++i) {
        uint64_t klen = rd64(p);
        std::string key((const char *) p, klen); p += klen;
        size_t vsz = kv_value_size(p);
        if (key == "general.alignment" && vsz == 8) memcpy(&alignment, p + 4, 4);
        p += vsz;
    }
    const uint8_t * kv_end = p;

    struct Info { std::string name; std::vector<uint64_t> dims; uint32_t type; uint64_t offset; };
    std::vector<Info> infos;
    for (uint64_t i = 0; i < ntensors; ++i) {
        uint64_t klen = rd64(p);
        Info inf; inf.name.assign((const char *) p, klen); p += klen;
        uint32_t nd = rd32(p);
        inf.dims.resize(nd);
        for (uint32_t d = 0; d < nd; ++d) inf.dims[d] = rd64(p);
        inf.type = rd32(p);
        inf.offset = rd64(p);
        infos.push_back(std::move(inf));
    }
    const uint64_t data_base = (uintptr_t)(p - buf.data() + alignment - 1) / alignment * alignment;
    fprintf(stderr, "tensors=%llu align=%u data@0x%llx\n", (unsigned long long) ntensors, alignment, (unsigned long long) data_base);

    std::ofstream out(out_path, std::ios::binary | std::ios::trunc);
    auto wr = [&](const void * d, size_t n) { out.write((const char *) d, n); };
    auto pad_to = [&](uint64_t pos, uint64_t align) {
        static const char zeros[64] = {};
        uint64_t pad = (align - pos % align) % align;
        if (pad) wr(zeros, pad);
        return pos + pad;
    };

    // header + verbatim kv block
    wr(buf.data(), 24);
    wr(kv_begin, kv_end - kv_begin);

    // tensor infos with new types + recomputed offsets
    std::vector<uint64_t> new_offsets(infos.size());
    uint64_t off = 0;
    for (size_t i = 0; i < infos.size(); ++i) {
        off = (off + alignment - 1) / alignment * alignment;
        new_offsets[i] = off;
        uint64_t elems = 1;
        for (uint64_t d : infos[i].dims) elems *= d;
        uint32_t t = whitelist.count(infos[i].name) ? (uint32_t) qtype : infos[i].type;
        size_t bytes;
        if (t == (uint32_t) qtype && infos[i].type == 0) {
            bytes = (size_t)(elems / infos[i].dims[0]) * ggml_row_size(qtype, infos[i].dims[0]);
        } else {
            bytes = (size_t) elems * 4;  // all source tensors here are f32
        }
        off += bytes;
    }
    for (size_t i = 0; i < infos.size(); ++i) {
        uint64_t nl = infos[i].name.size();
        wr(&nl, 8);
        wr(infos[i].name.data(), nl);
        uint32_t nd = infos[i].dims.size();
        wr(&nd, 4);
        for (uint64_t d : infos[i].dims) wr(&d, 8);
        uint32_t t = whitelist.count(infos[i].name) ? (uint32_t) qtype : infos[i].type;
        wr(&t, 4);
        wr(&new_offsets[i], 8);
    }
    uint64_t fpos = (uint64_t) out.tellp();
    uint64_t written = pad_to(fpos, alignment);

    std::vector<float> vals;
    std::vector<std::byte> qbuf;
    for (size_t i = 0; i < infos.size(); ++i) {
        const Info & inf = infos[i];
        uint64_t elems = 1;
        for (uint64_t d : inf.dims) elems *= d;
        const uint8_t * src = buf.data() + data_base + inf.offset;
        written = pad_to(written, alignment);
        if (whitelist.count(inf.name)) {
            if (inf.type != 0) { fprintf(stderr, "skip non-f32 %s\n", inf.name.c_str()); return 1; }
            if (inf.dims.size() < 2 || inf.dims[0] % 32) { fprintf(stderr, "bad shape %s\n", inf.name.c_str()); return 1; }
            int64_t rows = (int64_t)(elems / inf.dims[0]);
            vals.resize(elems);
            memcpy(vals.data(), src, elems * 4);
            qbuf.resize((size_t) rows * ggml_row_size(qtype, inf.dims[0]));
            size_t w = ggml_quantize_chunk(qtype, vals.data(), qbuf.data(), 0, rows, inf.dims[0], nullptr);
            if (w != qbuf.size()) { fprintf(stderr, "quantize mismatch %s\n", inf.name.c_str()); return 1; }
            wr(qbuf.data(), qbuf.size());
            written += qbuf.size();
        } else {
            size_t bytes = (size_t) elems * 4;
            wr(src, bytes);
            written += bytes;
        }
    }
    fprintf(stderr, "wrote %s (%llu MB)\n", out_path, (unsigned long long)(written >> 20));
    return 0;
}
