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
#
# ONE SLICE ONLY. `build.sh -p android` installs EVERY ABI it built under a
# single root (lib/arm64-v8a, lib/armeabi-v7a), so the bare lib/*/*.a glob would
# put two architectures' archives on one link line. Prefer the ABI subdirectory
# the toolchain named when it exists; the general case is caught below.
if (ANDROID AND IS_DIRECTORY "${FILAMENT_SDK}/lib/${ANDROID_ABI}")
    file(GLOB TTP_FILAMENT_ARCHIVES "${FILAMENT_SDK}/lib/${ANDROID_ABI}/*.a")
else()
    file(GLOB TTP_FILAMENT_ARCHIVES
            "${FILAMENT_SDK}/lib/*.a"
            "${FILAMENT_SDK}/lib/*/*.a")
endif()
list(LENGTH TTP_FILAMENT_ARCHIVES TTP_FILAMENT_ARCHIVE_COUNT)
if (TTP_FILAMENT_ARCHIVE_COUNT EQUAL 0)
    message(FATAL_ERROR "no static libs under ${FILAMENT_SDK}/lib — incomplete SDK install")
endif()

# TWO SLICES ON ONE LINK LINE, caught by name rather than by symptom. Apple TV
# device and simulator are both arm64 and Android installs every ABI together,
# so in both cases the wrong FILAMENT_SDK root produces a link that LOOKS
# plausible: the archives differ, the guard in include/filament/Engine.h does not
# catch it, and what you get is an unresolved-symbol wall or a binary that
# crashes on the first draw. A repeated basename is the tell, and it is cheap.
set(TTP_FILAMENT_SEEN "")
foreach(archive ${TTP_FILAMENT_ARCHIVES})
    get_filename_component(TTP_FILAMENT_BASE "${archive}" NAME)
    if ("${TTP_FILAMENT_BASE}" IN_LIST TTP_FILAMENT_SEEN)
        message(FATAL_ERROR
            "FILAMENT_SDK='${FILAMENT_SDK}' holds more than one slice: ${TTP_FILAMENT_BASE} "
            "appears twice under lib/. Point it at ONE architecture's install tree "
            "(Android: lib/<abi>; tvOS: filament-appletvos / filament-appletvsimulator, "
            "never the xcframework root).")
    endif()
    list(APPEND TTP_FILAMENT_SEEN "${TTP_FILAMENT_BASE}")
endforeach()

add_library(filament-sdk INTERFACE)
target_include_directories(filament-sdk INTERFACE "${FILAMENT_SDK}/include")
# backend/platforms/VulkanPlatform.h (the platform-customization override the
# Android renderer subclasses) includes <bluevk/BlueVK.h>, which the install
# tree does not carry — it lives only in the CHECKOUT the install was built
# from, above out/<config> — three levels up from the SDK root. Resolved only
# where it exists, so the tvOS and web slices (which never include a Vulkan
# header) are untouched.
get_filename_component(TTP_FILAMENT_CHECKOUT "${FILAMENT_SDK}/../../.." ABSOLUTE)
if (EXISTS "${TTP_FILAMENT_CHECKOUT}/libs/bluevk/include/bluevk/BlueVK.h")
    target_include_directories(filament-sdk INTERFACE
            "${TTP_FILAMENT_CHECKOUT}/libs/bluevk/include")
endif()
target_link_libraries(filament-sdk INTERFACE ${TTP_FILAMENT_ARCHIVES})
