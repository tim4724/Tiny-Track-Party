plugins {
    id("com.android.application")
    // Kotlin itself is AGP's since 9.0; only the Compose compiler is a plugin.
    id("org.jetbrains.kotlin.plugin.compose")
}

/**
 * `git ...` against the worktree, or null outside a git tree (a source tarball,
 * a CI checkout with no history). Every caller has a fallback; nothing here may
 * fail a build because git is absent.
 */
fun git(vararg args: String): String? = try {
    val p = ProcessBuilder(listOf("git") + args)
        .directory(rootDir).redirectErrorStream(false).start()
    val out = p.inputStream.bufferedReader().readText().trim()
    if (p.waitFor() == 0 && out.isNotEmpty()) out else null
} catch (_: Exception) {
    null
}

android {
    namespace = "games.couchpad.tinytrack"
    compileSdk = 37

    defaultConfig {
        applicationId = "games.couchpad.tinytrack"
        // 24 matches the CI leg and the ctest device build. Compose needs 21+
        // and Filament's GLES3 path 18+, so this floor is about what Android TV
        // boxes actually run rather than about either of those.
        minSdk = 24
        targetSdk = 36
        // versionCode stays PINNED at 1 on purpose. Deriving it from the commit
        // count is the usual trick and it is wrong for this tree: Android refuses
        // an install whose versionCode is lower than the installed one, and this
        // tree is worked in many worktrees at once, so hopping branches would
        // start answering INSTALL_FAILED_VERSION_DOWNGRADE on a sideload.
        versionCode = 1
        // WHICH COMMIT IS ON THE BOX — the question a stale install otherwise
        // answers identically to a fresh one, and `dumpsys package | grep
        // versionName` is how adb asks it. The tvOS twin writes the same string
        // into Generated/assets/version.txt for its debug lobby to show.
        versionName = "1.0-" + (git("rev-parse", "--short", "HEAD") ?: "nogit") +
            (if (git("status", "--porcelain") != null) "-dirty" else "")

        ndk {
            // BOTH, and armeabi-v7a is not the legacy one here. A Google TV
            // Streamer on Android 14 reports ro.product.cpu.abilist=
            // armeabi-v7a,armeabi and carries no /system/bin/linker64, so an
            // arm64-only APK simply does not run on it. See
            // native/scripts/build-runtime-android.sh.
            abiFilters += listOf("armeabi-v7a", "arm64-v8a")
        }
    }

    buildTypes {
        release {
            // SIGNED WITH THE DEBUG KEY, which is what makes a release APK
            // installable at all. Without a signingConfig here AGP emits
            // app-release-UNSIGNED.apk, which no device takes. (The install
            // itself is `adb -s "$SERIAL" install`, never gradlew installRelease
            // — see shells/androidtv/scripts/android-device.sh for why.)
            //
            // signingConfigs.debug rather than a keystore of our own on purpose:
            // AGP GENERATES ~/.android/debug.keystore on demand, so this needs no
            // secret, no local.properties entry and nothing on a CI runner. It
            // also keeps release and debug on ONE key, so the two variants upgrade
            // over each other instead of needing an uninstall between them. A real
            // distribution key replaces this one line and nothing else.
            signingConfig = signingConfigs.getByName("debug")

            // R8 ON. Off, the dex was 20.1 MB of a 22.8 MB APK — bigger than both
            // ABIs of the engine together, and over the multidex threshold — for
            // an app whose own Kotlin is a few hundred KB. It is unshrunk Compose.
            //
            // The JNI bridge is what kept it off, and the fix is proguard-rules.pro
            // (read it: the keeps are load-bearing and one of them is an absence).
            // Nothing here shrinks RESOURCES: res/ is 25 KB, so it would buy
            // nothing and add a failure mode.
            isMinifyEnabled = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
        }
    }

    // The engine .so files are BUILD OUTPUT of native/scripts/build-runtime-
    // android.sh, dropped into the default jniLibs directory already stripped.
    // Nothing here builds them; see settings.gradle.kts for why.

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlin {
        compilerOptions {
            jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
        }
    }

    buildFeatures {
        compose = true
        // NOT the default under AGP 8, and without it `BuildConfig` is never
        // generated at all — so `BuildConfigIsDebug` reflects onto a missing class,
        // answers false in a debug build, and `tokenRequire` throws nowhere. That is
        // the SECOND way this shell's assertions lost their teeth silently; the
        // first was `kotlin.assert` (see the shell's CLAUDE.md).
        buildConfig = true
    }

    packaging {
        jniLibs {
            // The .so are stripped on the way in by the build script, and
            // Gradle's own stripping would need the NDK on the Gradle side.
            keepDebugSymbols += "**/libttp_runtime_android.so"
            useLegacyPackaging = false
        }
    }

    // No sourceSets block: src/main/kotlin is already a default source directory
    // under AGP's built-in Kotlin support.
}

// THE TWO HAND-OFFS INTO THIS BUILD, BOTH OWNED BY IT NOW.
//
// Gradle is still not wired to CMake through externalNativeBuild, for the reason
// settings.gradle.kts gives — that would put the Filament SDK path, the pinned
// NDK and the fork checkout behind an IDE's idea of when to build. But "not a
// second build system" is not the same as "not Gradle's problem": both inputs
// used to be produced by scripts a human had to run first, IN AN ORDER, and a
// build that skipped either produced a perfectly good APK of the PREVIOUS engine
// or the PREVIOUS materials. That is the stale twin the shell's CLAUDE.md warns
// about in three places, and prose is the wrong enforcement mechanism for it.
//
// So: the asset staging (a file copy, not a build) RUNS here, and the engine (a
// real cross-compile) is CHECKED here and named if it is behind.

val stageAssets = tasks.register<Exec>("stageAssets") {
    group = "build"
    description = "Copy the bundled assets from the one place each is authored."
    // Cheap (~4 MB) and always correct, so it is not up-to-date-checked: an
    // input list would be a second, driftable copy of what the script stages.
    // Gradle hashes CONTENT, so mergeAssets still skips when nothing changed.
    commandLine("$rootDir/scripts/stage-assets.sh")
}

val checkEngine = tasks.register("checkEngine") {
    group = "verification"
    description = "Fail if the engine .so are missing or older than native/."
    doLast {
        // The CI leg builds the Kotlin half only — no NDK, no Filament SDK, so
        // no .so and nothing to be stale against. It says so with this flag.
        if (project.hasProperty("ttpNoEngine")) {
            logger.lifecycle("checkEngine: -PttpNoEngine — the APK will carry no engine.")
            return@doLast
        }
        val nativeDir = file("$rootDir/../../native")
        val sources = fileTree(nativeDir) {
            include("**/*.cc", "**/*.h", "**/*.cpp", "**/*.hpp", "**/*.inc")
            include("**/CMakeLists.txt", "**/*.cmake")
            exclude("build/**")     // per-worktree build trees, gitignored
        }
        val newest = sources.files.maxOfOrNull { it.lastModified() } ?: 0L
        val libs = listOf("armeabi-v7a", "arm64-v8a")
            .map { file("$rootDir/app/src/main/jniLibs/$it/libttp_runtime_android.so") }
            .filter { it.exists() }
        val how = "  native/scripts/build-runtime-android.sh   " +
            "(or shells/androidtv/scripts/build.sh, which owns the whole order)"
        if (libs.isEmpty()) {
            throw GradleException("no engine under app/src/main/jniLibs — build it:\n$how")
        }
        val stale = libs.filter { it.lastModified() < newest }
        if (stale.isNotEmpty()) {
            val newestFile = sources.files.maxByOrNull { it.lastModified() }
            throw GradleException(
                "the engine is older than native/ (${newestFile?.name} moved after it) — rebuild:\n" +
                    how + "\n  stale: " + stale.joinToString { it.parentFile.name },
            )
        }
    }
}

tasks.named("preBuild") { dependsOn(checkEngine, stageAssets) }

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2026.08.00")
    implementation(composeBom)

    implementation("androidx.core:core-ktx:1.19.0")
    // THE SYSTEM SPLASH, held until the game is ready. Not decoration: on API 31+
    // the platform shows a splash for every cold start whether an app asks or
    // not, and this library is the only way to (a) say what it looks like on
    // every version this ships to, back to minSdk, and (b) KEEP it up past the
    // first frame. Without it the launch window is whatever the system infers
    // from the theme — which for a dark Material parent is near-black, in front
    // of an app whose first frame is warm paper.
    implementation("androidx.core:core-splashscreen:1.0.1")
    implementation("androidx.activity:activity-compose:1.13.0")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-graphics")
    implementation("androidx.compose.foundation:foundation")
    // NOT androidx.tv:tv-material. Sticker Bash is flat colour on warm paper
    // with thick warm-ink outlines and hard zero-blur offset shadows; every
    // visual is custom drawing from design-tokens.json, so a Material component
    // library would be fought at every step. What a TV needs from Compose is the
    // FOCUS system, and that is in foundation.

    // The relay socket.
    implementation("com.squareup.okhttp3:okhttp:5.4.0")

    // The input fastlane's transport (Fastlane.kt). Android ships no system
    // WebRTC, so this is a prebuilt libwebrtc (org.webrtc.*) — the same
    // distribution the tvOS shell links as LiveKitWebRTC and HexStacker's TV
    // shell device-proved. It carries armeabi-v7a, which is NOT optional here:
    // see the abiFilters note above.
    //
    // IT IS BY FAR THE LARGEST THING IN THE APK — a prebuilt libwebrtc per
    // ABI, stored uncompressed (useLegacyPackaging = false), and abiFilters is
    // the only thing keeping it to two. A universal APK is the cost of not
    // shipping an App Bundle; measure before assuming it is the engine.
    //
    // The netcode is NOT in this dependency — ttp::fastlane::Link is, behind
    // the ttp_link_* walks — so what it buys is the PeerConnection and the
    // DataChannel and nothing else.
    implementation("io.github.webrtc-sdk:android:144.7559.12")

    // The join QR. Policy is copied from public/shared/qr.js — EC level L, a
    // one-module quiet zone — not the library.
    implementation("com.google.zxing:core:3.5.4")
}
