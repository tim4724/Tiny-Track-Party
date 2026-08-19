# R8 keeps for the release build. Three rules and one deliberate ABSENCE.
#
# THE BRIDGE IS RESOLVED BY NAME. native/runtime/ttp_jni.cc binds its exports in
# JNI_OnLoad via RegisterNatives against FindClass("games/couchpad/tinytrack/Ttp")
# and a table of (name, signature) pairs, so the class name, the method names and
# the descriptors are all live strings on the C++ side that no shrinker can see.
# A rename is an UnsatisfiedLinkError at library load — i.e. at the first frame,
# on the box, in the one build nobody runs before shipping.
-keep class games.couchpad.tinytrack.Ttp { *; }
-keep class games.couchpad.tinytrack.Ttp$* { *; }

# The generic form of the same thing, for any native declared elsewhere later.
# proguard-android-optimize.txt carries this too; it is repeated here so the rule
# survives someone swapping the default file out.
-keepclasseswithmembernames class * {
    native <methods>;
}

# NO KEEP FOR BuildConfig, AND THAT IS THE POINT. Tokens.kt reads it reflectively
# (Class.forName(...).getField("DEBUG")) so the file compiles in a unit test, and
# the catch answers `false` when the class is gone — which is exactly what a
# release build wants BuildConfigIsDebug to be. Adding a keep here would be
# harmless today and actively wrong the day anyone enables minify for debug: the
# reflection would then succeed and report DEBUG=true in a shrunk build. Two
# earlier mechanisms already lost this shell's assertions silently (kotlin.assert
# on ART, and AGP 8 generating no BuildConfig at all) — see the shell's CLAUDE.md.

# Hidden-API reflection in PerfDebug: android.os.SystemProperties is a platform
# class, so R8 never touches it and its own catch covers a box that refuses.
