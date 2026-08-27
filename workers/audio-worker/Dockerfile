FROM node:22-alpine

WORKDIR /app
COPY engine/audio-inspector.js engine/unreal-audio-handoff.js engine/load-local-env.js ./engine/
COPY workers/audio-worker/server.js ./workers/audio-worker/
COPY workers/audio-worker/providers ./workers/audio-worker/providers

ENV NODE_ENV=production \
    COMIC30_AUDIO_WORKER_HOST=0.0.0.0 \
    COMIC30_AUDIO_WORKER_PORT=5193 \
    COMIC30_AUDIO_WORKER_DATA_DIR=/data

VOLUME ["/data"]
EXPOSE 5193
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:5193/health').then(r=>r.json()).then(j=>process.exit(j.ready?0:1)).catch(()=>process.exit(1))"

CMD ["node", "workers/audio-worker/server.js"]
