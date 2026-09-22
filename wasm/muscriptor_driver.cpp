/*
 * Emscripten binding for audio.cpp's MuScriptor transcription path.
 *
 * Exposes a tiny API over the audiocpp C ABI:
 *   loadModel(path, threads)          -> bool (GGUF already in MEMFS)
 *   streamPush(Float32Array, rate)    -> array of note-event JSON strings
 *   streamFinish()                    -> full note-event JSON array string
 *   lastError()                       -> most recent audiocpp failure detail
 *
 * The model file is written into Emscripten's FS by the JS side before
 * loadModel is called. Audio is fed in ~5 s chunks; each push returns any
 * note events decoded so far so the UI can paint notes incrementally.
 */

#include "audiocpp.h"

#include <emscripten/bind.h>
#include <emscripten/val.h>

#include <string>
#include <vector>

namespace {

struct Engine {
    audiocpp_registry * registry = nullptr;
    audiocpp_model * model = nullptr;
    audiocpp_session * session = nullptr;
};

Engine g_engine;

std::string lastError() {
    const char * error = audiocpp_last_error();
    return error == nullptr ? std::string() : std::string(error);
}

bool loadModel(const std::string & path, int threads) {
    if (g_engine.session != nullptr) {
        audiocpp_session_free(g_engine.session);
        g_engine.session = nullptr;
    }
    if (g_engine.model != nullptr) {
        audiocpp_model_free(g_engine.model);
        g_engine.model = nullptr;
    }
    if (g_engine.registry == nullptr &&
        audiocpp_registry_create(nullptr, &g_engine.registry) != AUDIOCPP_OK) {
        return false;
    }

    const audiocpp_model_config config = { "muscriptor", nullptr, nullptr, nullptr };
    if (audiocpp_model_load(g_engine.registry, path.c_str(), &config, nullptr,
                            &g_engine.model) != AUDIOCPP_OK) {
        return false;
    }

    if (threads <= 0) {
        threads = 4;
    }
    const audiocpp_backend_config backend = { "cpu", 0, threads };
    /* The model's default graph arenas (~1.9 GB total) are lazy virtual
     * reservations on native builds but real linear-memory allocations on
     * wasm. Shrink them so the whole heap fits a wasm32 address space. */
    audiocpp_options * options = audiocpp_options_create();
    if (options != nullptr) {
        audiocpp_options_set(options, "muscriptor.weight_context_mb", "256");
        audiocpp_options_set(options, "muscriptor.weight_type", "q8_0");
        audiocpp_options_set(options, "muscriptor.conditioning_graph_arena_mb", "96");
        audiocpp_options_set(options, "muscriptor.decoder_prefill_graph_arena_mb", "384");
        audiocpp_options_set(options, "muscriptor.decoder_decode_graph_arena_mb", "192");
    }
    const audiocpp_status status = audiocpp_session_create(
        g_engine.model, "midi", "streaming", &backend, options,
        &g_engine.session);
    audiocpp_options_free(options);
    return status == AUDIOCPP_OK;
}

std::vector<float> toVector(const emscripten::val & pcm) {
    return emscripten::convertJSArrayToNumberVector<float>(pcm);
}

void appendArtifacts(const audiocpp_result * result, const emscripten::val & events) {
    if (result == nullptr) {
        return;
    }
    const size_t artifact_count = audiocpp_result_artifact_count(result);
    for (size_t i = 0; i < artifact_count; ++i) {
        audiocpp_artifact_kind kind;
        const char * id = nullptr;
        const void * payload = nullptr;
        size_t payload_bytes = 0;
        if (audiocpp_result_artifact(result, i, &kind, &id, &payload,
                                     &payload_bytes) != AUDIOCPP_OK ||
            payload == nullptr) {
            continue;
        }
        events.call<void>(
            "push",
            std::string(static_cast<const char *>(payload), payload_bytes));
    }
}

void drainEventsInto(const emscripten::val & events) {
    for (;;) {
        audiocpp_event * event = nullptr;
        if (audiocpp_stream_next_event(g_engine.session, &event) != AUDIOCPP_OK ||
            event == nullptr) {
            break;
        }
        appendArtifacts(audiocpp_event_as_result(event), events);
        audiocpp_event_free(event);
    }
}

emscripten::val streamBegin(int sampleRate, int channels) {
    if (g_engine.session == nullptr) {
        return emscripten::val::global("Error").new_(std::string("model not loaded"));
    }
    audiocpp_request * request = audiocpp_request_create();
    if (request == nullptr) {
        return emscripten::val::global("Error").new_(std::string("request allocation failed"));
    }
    if (audiocpp_request_set_audio(request, nullptr, 0, sampleRate, channels) != AUDIOCPP_OK) {
        audiocpp_request_free(request);
        return emscripten::val::global("Error").new_(lastError());
    }
    const audiocpp_status status = audiocpp_stream_start(g_engine.session, request);
    audiocpp_request_free(request);
    if (status != AUDIOCPP_OK) {
        return emscripten::val::global("Error").new_(lastError());
    }
    return emscripten::val::undefined();
}

emscripten::val streamPush(const emscripten::val & pcm, int sampleRate,
                           double startSeconds) {
    if (g_engine.session == nullptr) {
        return emscripten::val::global("Error").new_(std::string("model not loaded"));
    }
    const std::vector<float> samples = toVector(pcm);
    if (samples.empty()) {
        return emscripten::val::array();
    }
    audiocpp_event * produced = nullptr;
    const audiocpp_status status = audiocpp_stream_push(
        g_engine.session, samples.data(), samples.size(), sampleRate, 1,
        static_cast<int64_t>(startSeconds * sampleRate), &produced);
    /* The push decodes newly completed 5 s segments eagerly; note events it
     * produced ride back on the returned event's artifacts. */
    emscripten::val events = emscripten::val::array();
    if (produced != nullptr) {
        appendArtifacts(audiocpp_event_as_result(produced), events);
        audiocpp_event_free(produced);
    }
    if (status != AUDIOCPP_OK) {
        return emscripten::val::global("Error").new_(lastError());
    }
    drainEventsInto(events);
    return events;
}

emscripten::val streamFinish() {
    emscripten::val out = emscripten::val::object();
    if (g_engine.session == nullptr) {
        out.set("error", std::string("model not loaded"));
        return out;
    }
    audiocpp_result * result = nullptr;
    if (audiocpp_stream_finish(g_engine.session, &result) != AUDIOCPP_OK ||
        result == nullptr) {
        /* A failed finish leaves the stream (and its buffered audio) in
         * flight — reset so the heap is released before the next run. */
        if (result != nullptr) {
            audiocpp_result_free(result);
        }
        audiocpp_stream_reset(g_engine.session);
        out.set("error", lastError());
        return out;
    }
    const char * text = nullptr;
    if (audiocpp_result_text(result, &text, nullptr) == AUDIOCPP_OK && text != nullptr) {
        out.set("eventsJson", std::string(text));
    }
    const size_t artifact_count = audiocpp_result_artifact_count(result);
    for (size_t i = 0; i < artifact_count; ++i) {
        audiocpp_artifact_kind kind;
        const char * id = nullptr;
        const void * payload = nullptr;
        size_t payload_bytes = 0;
        if (audiocpp_result_artifact(result, i, &kind, &id, &payload,
                                     &payload_bytes) == AUDIOCPP_OK &&
            kind == AUDIOCPP_ARTIFACT_MIDI && payload != nullptr) {
            emscripten::val midi = emscripten::val::global("Uint8Array").new_(payload_bytes);
            emscripten::val heap = emscripten::val::module_property("HEAPU8");
            midi.call<void>("set",
                            heap.call<emscripten::val>(
                                "subarray",
                                reinterpret_cast<uintptr_t>(payload),
                                reinterpret_cast<uintptr_t>(payload) + payload_bytes));
            out.set("midi", midi);
        }
    }
    audiocpp_result_free(result);
    if (audiocpp_stream_reset(g_engine.session) != AUDIOCPP_OK) {
        out.set("resetError", lastError());
    }
    return out;
}

void streamAbort() {
    if (g_engine.session != nullptr) {
        audiocpp_stream_reset(g_engine.session);
    }
}

void unload() {
    if (g_engine.session != nullptr) {
        audiocpp_session_free(g_engine.session);
        g_engine.session = nullptr;
    }
    if (g_engine.model != nullptr) {
        audiocpp_model_free(g_engine.model);
        g_engine.model = nullptr;
    }
    if (g_engine.registry != nullptr) {
        audiocpp_registry_free(g_engine.registry);
        g_engine.registry = nullptr;
    }
}

}  // namespace

EMSCRIPTEN_BINDINGS(muscriptor) {
    emscripten::function("loadModel", &loadModel);
    emscripten::function("streamBegin", &streamBegin);
    emscripten::function("streamPush", &streamPush);
    emscripten::function("streamFinish", &streamFinish);
    emscripten::function("streamAbort", &streamAbort);
    emscripten::function("unload", &unload);
    emscripten::function("lastError", &lastError);
}
