# Builds the self-contained static site: two plain Node scripts turn the CSV game
# data + calculation engine into one HTML file with no framework and no client-side
# build step at request time. See concepts/build/README or the repo README for the
# manual equivalent (prepare-data-v2.js, then assemble.js).
FROM node:20-alpine AS builder
WORKDIR /app
COPY public/csv ./public/csv
COPY public/icons ./public/icons
COPY concepts/build ./concepts/build
RUN node concepts/build/prepare-data-v2.js && node concepts/build/assemble.js

FROM nginx:alpine AS runner
COPY --from=builder /app/concepts/dist/v1-ops-terminal.html /usr/share/nginx/html/index.html
EXPOSE 80
