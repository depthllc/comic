FROM node:22-alpine

WORKDIR /app
COPY engine/glb-inspector.js engine/rig-inspector.js engine/animation-inspector.js engine/unreal-rig-handoff.js engine/unreal-animation-handoff.js engine/load-local-env.js ./engine/
COPY workers/animation-worker/server.js workers/animation-worker/retarget-profiles.js ./workers/animation-worker/
COPY workers/animation-worker/providers ./workers/animation-worker/providers

ENV NODE_ENV=production \
    COMIC30_ANIMATION_WORKER_HOST=0.0.0.0 \
    COMIC30_ANIMATION_WORKER_PORT=5192 \
    COMIC30_ANIMATION_WORKER_DATA_DIR=/data

VOLUME ["/data"]
EXPOSE 5192
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:5192/health').then(r=>r.json()).then(j=>process.exit(j.ready?0:1)).catch(()=>process.exit(1))"

CMD ["node", "workers/animation-worker/server.js"]
