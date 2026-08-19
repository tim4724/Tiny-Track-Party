// The Android TV shell is its own Gradle build, NOT a module of anything.
//
// The engine it loads is built by native/scripts/build-runtime-android.sh into
// app/src/main/jniLibs/<abi>/, exactly as the tvOS app links a .a that the
// tvOS script produced. Gradle is deliberately not wired to CMake through
// externalNativeBuild: that would make every Gradle invocation need the
// Filament SDK path, the pinned NDK and the fork checkout, and it would put the
// engine build behind an IDE's idea of when to run it. Two build systems, one
// hand-off, and the hand-off is a directory of .so files.

pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "TinyTrackParty"
include(":app")
