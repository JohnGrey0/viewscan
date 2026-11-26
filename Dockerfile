FROM node:22-alpine

WORKDIR /app
# No dependencies: the server and the page are plain files.
COPY package.json server.js ./
COPY public ./public

ENV PORT=8080 \
    HOST=0.0.0.0 \
    SCANS_DIR=/scans \
    CACHE_DIR=/cache

EXPOSE 8080
CMD ["node", "server.js"]
