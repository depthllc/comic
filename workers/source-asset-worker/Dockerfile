FROM node:22-alpine

WORKDIR /app
COPY engine/glb-inspector.js engine/load-local-env.js ./engine/
COPY workers/source-asset-worker/server.js ./workers/source-asset-worker/server.js
COPY workers/source-asset-worker/providers ./workers/source-asset-worker/providers

ENV NODE_ENV=production \
    COMIC30_ASSET_WORKER_HOST=0.0.0.0 \
    COMIC30_ASSET_WORKER_PORT=5190 \
    COMIC30_ASSET_WORKER_DATA_DIR=/data

VOLUME ["/data"]
EXPOSE 5190
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:5190/health').then(r=>r.json()).then(j=>process.exit(j.ready?0:1)).catch(()=>process.exit(1))"

CMD ["node", "workers/source-asset-worker/server.js"]
