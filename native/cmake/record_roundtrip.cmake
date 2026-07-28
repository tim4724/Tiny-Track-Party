# Re-record a golden trace with the C++ CLI's --record mode and require the output
# to be BYTE-IDENTICAL to the committed fixture. Run via ctest (see the record_*
# tests in native/CMakeLists.txt); needs -DCLI -DFIXTURE -DOUT.
get_filename_component(_outDir "${OUT}" DIRECTORY)
file(MAKE_DIRECTORY "${_outDir}")
# Under a cross build (emscripten) the CLI is a .js that needs its emulator —
# add_test() would supply it automatically, but a cmake -P script must do so
# itself, so EMULATOR is threaded through. It may be a list (e.g. "node;--flag").
set(_cmd)
if(EMULATOR)
  list(APPEND _cmd ${EMULATOR})
endif()
list(APPEND _cmd "${CLI}" --record "${FIXTURE}" "--out=${OUT}")
# Some checks need one more positional after the flags (audio_check re-races the
# golden traces, so it still takes the traces directory).
if(EXTRA)
  list(APPEND _cmd "${EXTRA}")
endif()
execute_process(COMMAND ${_cmd} RESULT_VARIABLE _rc)
if(NOT _rc EQUAL 0)
  message(FATAL_ERROR "--record failed (exit ${_rc}) for ${FIXTURE}")
endif()
file(SHA256 "${FIXTURE}" _want)
file(SHA256 "${OUT}" _got)
if(NOT _want STREQUAL _got)
  message(FATAL_ERROR
    "re-recorded trace differs from the committed fixture\n  fixture ${FIXTURE} (${_want})\n  output  ${OUT} (${_got})")
endif()
