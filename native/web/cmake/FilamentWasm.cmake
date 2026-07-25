# IMPORTED interface over the installed Filament wasm SDK
# (produced by scripts/build-wasm.sh: fork build.sh -p wasm release + ninja install).
# FILAMENT_SDK must point at .../out/wasm-release/filament.

if (NOT DEFINED FILAMENT_SDK OR NOT EXISTS "${FILAMENT_SDK}/include/filament/Engine.h")
    message(FATAL_ERROR "FILAMENT_SDK not set or invalid: '${FILAMENT_SDK}' — run scripts/build-wasm.sh")
endif()

# Link every installed archive; wasm-ld dead-strips what the app doesn't use.
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
