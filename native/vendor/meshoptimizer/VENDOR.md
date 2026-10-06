# Vendored meshoptimizer header

Upstream: https://github.com/zeux/meshoptimizer — **the copy inside the pinned
Filament checkout**, `third_party/meshoptimizer/src/meshoptimizer.h` (0.18 at
the pin this was taken from).

- **License:** MIT (see `LICENSE`).

## Why only the header

Every Filament SDK slice we build (web, Android, tvOS) installs and links
`libmeshoptimizer.a`, but no SDK installs its header, and CI builds the renderer
against an SDK install with no checkout beside it. The renderer calls two
functions (`meshopt_simplify`, `meshopt_simplifyScale`) for the static meshes'
far forms (`TtpRenderer::farForm`), so the header is all it needs.

## Updating

The header must match the library the pinned SDK links, and its API has C
linkage, so a drifted header would still link. `build-runtime-web.sh` refuses to
build when this copy differs from the pinned checkout's; on a Filament pin bump,
copy `third_party/meshoptimizer/src/meshoptimizer.h` and `LICENSE` from the new
checkout over these.
