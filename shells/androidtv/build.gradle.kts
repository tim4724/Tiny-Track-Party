// No org.jetbrains.kotlin.android here. AGP 9.0 BUILT KOTLIN IN and now refuses
// that plugin outright ("no longer required for Kotlin support since AGP 9.0"),
// so a build file copied from any pre-9 project fails at the first line. Kotlin
// options are configured under `android { kotlin { } }` instead.
plugins {
    id("com.android.application") version "9.3.1" apply false
    id("org.jetbrains.kotlin.plugin.compose") version "2.4.10" apply false
}
