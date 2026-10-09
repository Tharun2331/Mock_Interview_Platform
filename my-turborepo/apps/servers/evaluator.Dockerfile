# syntax=docker/dockerfile:1
#
# The Evaluator Lambda image (ADR-0009). Build from the MONOREPO ROOT, since
# the server imports @repo/shared from packages/:
#
#   docker build --platform linux/arm64 -f apps/servers/evaluator.Dockerfile .
#
# apps/servers/scripts/deploy-evaluator.ts runs this, pushes and deploys.
#
# Bun has no managed Lambda runtime, so the function is a custom runtime: the
# Evaluator compiled into one self-contained executable that IS the runtime
# (lambda.ts speaks the Runtime API itself), on AWS's minimal provided.al2023
# base. No Bun install and no node_modules in the final image.

# ---------------------------------------------------------------------------
# Build: on the build machine's own architecture, so an x86 laptop never
# emulates arm64 to install packages. Bun cross-compiles to the target instead.
# ---------------------------------------------------------------------------
FROM --platform=$BUILDPLATFORM oven/bun:1.3.14 AS build
ARG TARGETARCH
WORKDIR /repo

# Manifests first, so a source change does not invalidate the install layer.
# Every workspace's package.json has to be present or the frozen lockfile no
# longer matches the workspace; apps/web contributes its manifest only.
COPY package.json bun.lock ./
COPY apps/servers/package.json apps/servers/
COPY apps/web/package.json apps/web/
COPY packages packages
RUN bun install --frozen-lockfile --production --ignore-scripts

COPY apps/servers apps/servers

# Bun names the x86 target x64; Docker names it amd64.
RUN case "$TARGETARCH" in \
      arm64) BUN_TARGET=bun-linux-arm64 ;; \
      amd64) BUN_TARGET=bun-linux-x64 ;; \
      *) echo "unsupported architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac \
 && bun build apps/servers/lambda.ts --compile --minify --sourcemap \
      --define 'process.env.NODE_ENV="production"' \
      --target="$BUN_TARGET" --outfile /out/bootstrap
# The --define is load-bearing: Bun replaces process.env.NODE_ENV with a
# constant at build time, so without it the binary believes it is in
# development whatever the runtime environment says. See isProduction in
# apps/servers/lib/config.ts.

# ---------------------------------------------------------------------------
# Runtime: distroless, not AWS's provided.al2023.
#
# Lambda runs any image whose entrypoint implements the Runtime API, and this
# binary does (lambda.ts) — so the image needs no OS beyond what the binary
# links: glibc and the C++ runtime. provided.al2023 also ships a shell, dnf,
# rpm, curl, libxml2 and pcre2, none of which ever run here, and its first ECR
# scan (2026-10-02) found 15 CVEs in exactly those (8 high). distroless/cc has
# no shell and no package manager, so there is nothing of that kind to find.
#
# Nothing here executes at build time, so building for arm64 on x86 needs no
# emulation at all.
# ---------------------------------------------------------------------------
FROM gcr.io/distroless/cc-debian12
# Lambda runs the function as a non-root user, so the binary must be
# world-executable.
COPY --from=build --chmod=755 /out/bootstrap /bootstrap
ENTRYPOINT ["/bootstrap"]
