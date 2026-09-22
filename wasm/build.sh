#!/bin/sh
# Rebuild the MuScriptor WASM module (public/models/muscriptor/muscriptor.{js,wasm}).
#
# Prereqs: emscripten (emcc/emcmake on PATH), cmake, and a sibling checkout of
# audio.cpp at ../audio.cpp containing the muscriptor model sources.
# The GGUF is NOT built here — drop muscriptor-small-q8_0.gguf into
# public/models/muscriptor/ separately (it is gitignored; generate it from the
# f32 file with wasm/quantize_gguf.cpp).

set -eu

AUDIOCPP="${AUDIOCPP:-$(cd "$(dirname "$0")/../../audio.cpp" && pwd)}"
APP="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$APP/public/models/muscriptor"
BUILD="$AUDIOCPP/build-wasm"

# 1. Configure + build the minimal static libs (muscriptor model set only).
emcmake cmake -B "$BUILD" -S "$AUDIOCPP" \
  -DCMAKE_BUILD_TYPE=Release \
  -DEMSCRIPTEN_SYSTEM_PROCESSOR=wasm32 \
  -DAUDIOCPP_MODEL_SET=custom \
  -DAUDIOCPP_MODELS=muscriptor \
  -DENGINE_ENABLE_CUDA=OFF -DENGINE_ENABLE_HIP=OFF \
  -DENGINE_ENABLE_VULKAN=OFF -DENGINE_ENABLE_METAL=OFF \
  -DENGINE_ENABLE_OPENMP=OFF -DGGML_OPENMP=OFF \
  -DENGINE_ENABLE_NATIVE_CPU=OFF -DENGINE_ENABLE_CPU_ALL_VARIANTS=OFF \
  -DGGML_NATIVE=OFF -DGGML_BACKEND_DL=OFF \
  '-DCMAKE_C_FLAGS=-pthread -fexceptions -msimd128' \
  '-DCMAKE_CXX_FLAGS=-pthread -fexceptions -msimd128'

# Only the libraries are needed; the CLI/server exe targets do not link on
# wasm (posix_spawnp etc.) — build the lib targets explicitly.
cmake --build "$BUILD" --parallel --target ggml engine_core engine_runtime

CXXFLAGS="-pthread -fexceptions -msimd128 -O3 -DNDEBUG -std=c++17"
INCLUDES="-I$AUDIOCPP/include -I$BUILD/generated \
  -I$AUDIOCPP/external/ggml/include \
  -I$AUDIOCPP/external/sentencepiece/src -I$AUDIOCPP/external/llama_tokenizer"

# 2. C API facade + the embind driver.
em++ $CXXFLAGS $INCLUDES -o "$BUILD/audiocpp_capi.o" -c "$AUDIOCPP/src/capi/audiocpp.cpp"
em++ $CXXFLAGS $INCLUDES -o "$BUILD/muscriptor_driver.o" -c "$APP/wasm/muscriptor_driver.cpp"

# 3. Link the ES-module bundle. Fixed 3 GB shared memory (ALLOW_MEMORY_GROWTH
#    with pthreads is slow; measured decode peak is ~2.1 GB, flat vs duration,
#    so 3 GB covers it with headroom — 2 GB OOMed inside stream_finish).
#    PTHREAD_POOL_SIZE must exceed the ggml worker count.
mkdir -p "$OUT"
em++ -pthread -fexceptions -msimd128 -O3 -DNDEBUG \
  --bind \
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createMuscriptorModule \
  -sENVIRONMENT=web,worker \
  -sINITIAL_MEMORY=3221225472 \
  -sSTACK_SIZE=1048576 \
  -sPTHREAD_POOL_SIZE=16 \
  -sEXIT_RUNTIME=0 \
  -sFILESYSTEM=1 \
  "-sEXPORTED_RUNTIME_METHODS=['FS','HEAPU8']" \
  -o "$OUT/muscriptor.js" \
  "$BUILD/muscriptor_driver.o" "$BUILD/audiocpp_capi.o" \
  "$BUILD/libengine_runtime.a" \
  "$BUILD/ggml/src/libggml.a" "$BUILD/ggml/src/libggml-cpu.a" "$BUILD/ggml/src/libggml-base.a" \
  "$BUILD/external/sentencepiece/src/libsentencepiece.a" \
  "$BUILD/libcjson_vendor.a" "$BUILD/libyaml_vendor.a"

echo "wrote $OUT/muscriptor.{js,wasm}"
