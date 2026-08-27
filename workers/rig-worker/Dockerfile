FROM node:22-alpine

WORKDIR /app
COPY engine/glb-inspector.js engine/rig-inspector.js engine/unreal-rig-handoff.js engine/load-local-env.js ./engine/
COPY workers/rig-worker/server.js ./workers/rig-worker/server.js
COPY workers/rig-worker/providers ./workers/rig-worker/providers
COPY workers/rig-worker/strategies ./workers/rig-worker/strategies

ENV NODE_ENV=production \
    COMIC30_RIG_WORKER_HOST=0.0.0.0 \
    COMIC30_RIG_WORKER_PORT=5191 \
    COMIC30_RIG_WORKER_DATA_DIR=/data

VOLUME ["/data"]
EXPOSE 5191
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:5191/health').then(r=>r.json()).then(j=>process.exit(j.generationReady?0:1)).catch(()=>process.exit(1))"

CMD ["node", "workers/rig-worker/server.js"]
