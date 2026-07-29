# IMPORTED interface over an installed Filament SDK. FILAMENT_SDK must point at
# the install root — the directory holding include/filament/Engine.h and lib/.
#
# PLATFORM-AGNOSTIC ON PURPOSE, and it was called FilamentWasm.cmake until the
# port audit: nothing below asks which platform produced the SDK, because the
# answer never changed what it does. Each target points at its own SDK build
# (web: out/wasm-release/filament, from native/scripts/build-runtime-web.sh;
# tvOS and Android: the fork's build.sh -p tvos / -p android).
#
# Materials are the other half of an SDK and are NOT here: .filamat blobs are
# compiled per backend by the fork's OWN matc (never a system one — they are
# MATERIAL_VERSION locked to the tree). See native/scripts/build-materials.sh.

if (NOT DEFINED FILAMENT_SDK OR NOT EXISTS "${FILAMENT_SDK}/include/filament/Engine.h")
    message(FATAL_ERROR
        "FILAMENT_SDK not set or invalid: '${FILAMENT_SDK}' — point it at an installed "
        "Filament SDK root (native/scripts/build-runtime-web.sh builds and installs the web one)")
endif()

# Link every installed archive; the linker dead-strips what the app doesn't use.
file(GLOB TTP_FILAMENT_ARCHIVES
        "${FILAMENT_SDK}/lib/*.a"
        "${FILAMENT_SDK}/lib/*/*.a")
list(LENGTH TTP_FILAMENT_ARCHIVES TTP_FILAMENT_ARCHIVE_COUNT)
if (TTP_FILAMENT_ARCHIVE_COUNT EQUAL 0)
    message(FATAL_ERROR "no static libs under ${FILAMENT_SDK}/lib — incomplete SDK install")
endif()

add_library(filament-sdk INTERFACE)
target_include_directories(filament-sdk INTERFACE "${FILAMENT_SDK}/include")
target_link_libraries(filament-sdk INTERFACE ${TTP_FILAMENT_ARCHIVES})
