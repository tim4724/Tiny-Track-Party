# Run probe_cli's laptime sweep and validate the SHAPE of what it printed: one JSON
# row per catalogue track, each with a plausible lap time. Needs -DCLI -DTRACKS
# (expected row count); -DEMULATOR is threaded through for cross builds, exactly as
# in record_roundtrip.cmake.
#
# Why a real validator instead of add_test(COMMAND probe_cli laptime): the probe is
# an INSTRUMENT, and an instrument that exits 0 while printing nothing has rotted
# just as thoroughly as one that crashes. It earns its CI slot because it is the
# tool that surfaced the racing-line bug (as non-reproducible lap times across a
# sweep), and it is the only thing in the tree that races the catalogue for full
# laps rather than a fixed frame budget.
set(_cmd)
if(EMULATOR)
  list(APPEND _cmd ${EMULATOR})
endif()
list(APPEND _cmd "${CLI}" laptime --json)

execute_process(COMMAND ${_cmd} OUTPUT_VARIABLE _out ERROR_VARIABLE _err RESULT_VARIABLE _rc)
if(NOT _rc EQUAL 0)
  message(FATAL_ERROR "probe_cli laptime --json failed (exit ${_rc})\n${_err}")
endif()

string(REPLACE "\n" ";" _lines "${_out}")
set(_rows 0)
foreach(_line IN LISTS _lines)
  if(_line STREQUAL "")
    continue()
  endif()
  # {"track":"tidepool","length":390.7,"lapSec":44.2,"brakeFrac":0.001,"laps":3}
  if(NOT _line MATCHES "\"track\":\"([a-z0-9_-]+)\"")
    message(FATAL_ERROR "probe row has no track id:\n  ${_line}")
  endif()
  set(_track "${CMAKE_MATCH_1}")
  if(NOT _line MATCHES "\"lapSec\":([0-9]+\\.?[0-9]*)")
    message(FATAL_ERROR "probe row for ${_track} has no lapSec:\n  ${_line}")
  endif()
  set(_lap "${CMAKE_MATCH_1}")
  # A lap under 5 s or over 300 s means the bot never drove or never finished —
  # both have happened, and both print a row that a bare exit-code check accepts.
  if(_lap LESS 5 OR _lap GREATER 300)
    message(FATAL_ERROR "probe lap time for ${_track} is implausible: ${_lap}s")
  endif()
  math(EXPR _rows "${_rows} + 1")
endforeach()

if(NOT _rows EQUAL ${TRACKS})
  message(FATAL_ERROR
    "probe_cli printed ${_rows} rows, expected one per catalogue track (${TRACKS}) — "
    "a track that cannot be probed is a track no balance reading covers")
endif()
message(STATUS "probe smoke: ${_rows} tracks, all lap times plausible")
