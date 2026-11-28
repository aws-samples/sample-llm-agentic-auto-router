# Router stack catalog Lambdas (ARM64): catalog-refresh, catalog-grant, catalog-grant-cleanup, provider-dns-sync (nat-dns); each function selects its handler with
# the image CMD (infra/src/stack.ts CATALOG_LAMBDA_CMD). Build context: the repository root, filtered by the
# RouterStack's asset excludes (catalogLambdaCode). Separate from the console image on purpose: the IAM-writing
# function carries no console code.
# Like the other images, the TypeScript sources run directly (Node 24 type stripping). Workspace packages are pnpm
# symlinks with real paths outside node_modules, which type stripping requires.
# Pin both images by digest before a production deploy (docker buildx imagetools inspect <image>).
ARG NODE_IMAGE=public.ecr.aws/docker/library/node:24-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c
ARG LAMBDA_IMAGE=public.ecr.aws/lambda/nodejs:24
FROM --platform=linux/arm64 ${NODE_IMAGE} AS build
WORKDIR /var/task
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/pricing/package.json packages/pricing/
COPY packages/core/package.json packages/core/
COPY packages/catalog-service/package.json packages/catalog-service/
RUN pnpm install --frozen-lockfile --prod --filter @auto-router/catalog-service...
COPY packages/pricing/src packages/pricing/src
COPY packages/core/src packages/core/src
COPY packages/catalog-service/src packages/catalog-service/src
COPY infra/lambda/handlers/catalog-*.mjs handlers/
RUN find packages -name '*.test.ts' -delete \
 && rm -rf packages/*/src/__fixtures__ packages/*/src/test-helpers.ts packages/*/src/test-fixtures.ts \
 && chmod -R a+rX .  # readable by the runtime user whatever the deployer's umask (2026-11-18: umask 077 broke a deploy)

FROM --platform=linux/arm64 ${LAMBDA_IMAGE}
COPY --from=build /var/task ${LAMBDA_TASK_ROOT}
ENV NODE_ENV=production
# The function's ImageConfig.Command overrides this (one of handlers/catalog-*.handler).
# nosemgrep: missing-user -- Lambda runs container images as its own least-privileged default user, so the image needs no USER (https://docs.aws.amazon.com/lambda/latest/dg/images-create.html)
CMD ["handlers/catalog-grant.handler"]
