# wasm build of libttp-renderer + the web shell. Configure with emcmake:
#   emcmake cmake -S native/web -B native/web/build -G Ninja \
#       -DCMAKE_BUILD_TYPE=Release -DFILAMENT_SDK=<fork>/out/wasm-release/filament
# Driven by scripts/build-wasm.sh; outputs ttp.js + ttp.wasm.
cmake_minimum_required(VERSION 3.19)
project(ttp-web CXX)

if (NOT EMSCRIPTEN)
    message(FATAL_ERROR "this target is emscripten-only — configure with emcmake")
endif()

set(CMAKE_CXX_STANDARD 20)          # match the Filament SDK build
set(CMAKE_CXX_STANDARD_REQUIRED ON)

include(cmake/FilamentWasm.cmake)

# libttp-renderer: platform-free (no emscripten includes) — the code that later
# ships on tvOS/Android.
add_library(ttp_renderer STATIC
        ../renderer/src/TtpRenderer.cpp)
target_include_directories(ttp_renderer PUBLIC
        ../include
        ../renderer/src)
target_link_libraries(ttp_renderer PUBLIC filament-sdk)
target_compile_options(ttp_renderer PRIVATE -fno-rtti -fno-exceptions)

add_executable(ttp shell/main_web.cpp)
target_link_libraries(ttp PRIVATE ttp_renderer)
target_compile_options(ttp PRIVATE -fno-rtti -fno-exceptions)
target_link_options(ttp PRIVATE
        -sALLOW_MEMORY_GROWTH=1
        -sUSE_WEBGL2=1
        -sFULL_ES3
        -sMIN_WEBGL_VERSION=2
        -sMAX_WEBGL_VERSION=2
        -sMODULARIZE=1
        -sEXPORT_ES6=1
        -sEXPORT_NAME=createTtpModule
        -sENVIRONMENT=web
        -sEXPORTED_FUNCTIONS=_malloc,_free
        -sEXPORTED_RUNTIME_METHODS=HEAPU8,HEAPF32,stringToNewUTF8
        $<$<CONFIG:Debug>:-sASSERTIONS=1>
        $<$<CONFIG:Debug>:-sGL_ASSERTIONS=1>)
set_target_properties(ttp PROPERTIES SUFFIX ".js")
