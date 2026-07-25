# Re-record a golden trace with the C++ CLI's --record mode and require the output
# to be BYTE-IDENTICAL to the committed fixture. Run via ctest (see the record_*
# tests in native/CMakeLists.txt); needs -DCLI -DFIXTURE -DOUT.
get_filename_component(_outDir "${OUT}" DIRECTORY)
file(MAKE_DIRECTORY "${_outDir}")
execute_process(COMMAND "${CLI}" --record "${FIXTURE}" "--out=${OUT}" RESULT_VARIABLE _rc)
if(NOT _rc EQUAL 0)
  message(FATAL_ERROR "--record failed (exit ${_rc}) for ${FIXTURE}")
endif()
file(SHA256 "${FIXTURE}" _want)
file(SHA256 "${OUT}" _got)
if(NOT _want STREQUAL _got)
  message(FATAL_ERROR
    "re-recorded trace differs from the committed fixture\n  fixture ${FIXTURE} (${_want})\n  output  ${OUT} (${_got})")
endif()
