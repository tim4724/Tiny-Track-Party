// The two GLES3 entry points Filament links that WebGL2 does not have.
//
// WebGL2 has no buffer mapping at all. Emscripten ships glMapBufferRange only
// under -sFULL_ES3, and even then its implementation returns 0 for every access
// mask Filament asks for: it rejects GL_MAP_READ_BIT and GL_MAP_UNSYNCHRONIZED_BIT
// outright, and Filament passes one or the other at every call site
// (OpenGLDriver::updateBufferObjectUnsynchronized uses UNSYNCHRONIZED, the
// readPixels paths use READ, and GLMemoryMappedBuffer is already #if'd out for
// __EMSCRIPTEN__). Filament handles the null and falls back to glBufferSubData.
//
// So these stubs are behaviour-identical to the emulation we were linking — and
// providing them ourselves is what lets the module drop -sFULL_ES3. That matters
// because -sFULL_ES3 implies -sFULL_ES2 (tools/link.py), and FULL_ES2 wraps
// glBindVertexArray in a SYNCHRONOUS getParameter(ELEMENT_ARRAY_BUFFER_BINDING)
// to keep its client-side-array bookkeeping current. Filament binds a VAO per
// draw, so that was ~180 blocking round-trips to the GPU process every frame.
// Filament never passes client-side arrays; the emulation only ever cost us.
addToLibrary({
  glMapBufferRange: (target, offset, length, access) => 0,
  glUnmapBuffer: (target) => 1, // GL_TRUE; unreachable, since mapping never succeeds
});
