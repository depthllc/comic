"use strict";

const SCHEMA = "comic30.unreal-audio-handoff.v1";

function createUnrealAudioHandoff({ productionRunId, clips }) {
  if (!productionRunId) throw new Error("Audio handoff requires a production run ID.");
  if (!Array.isArray(clips) || !clips.length) throw new Error("Audio handoff requires validated clips.");
  const normalized = clips.map((clip) => {
    if (!clip?.id || !clip?.artifact?.sha256 || !clip?.artifact?.bytes || clip.validation?.audioQa?.passed !== true) {
      throw new Error(`${clip?.name || "Audio clip"} lacks passing audio evidence.`);
    }
    if (clip?.license?.commercialUseAllowed !== true || !clip?.provenance?.model) {
      throw new Error(`${clip?.name || "Audio clip"} lacks commercial-use licensing or model provenance.`);
    }
    return {
      id: clip.id,
      name: clip.name,
      kind: clip.kind,
      prompt: clip.prompt || "",
      loop: clip.loop === true,
      durationSeconds: Number(clip.validation.metrics?.durationSeconds || 0),
      sampleRate: Number(clip.validation.metrics?.sampleRate || 0),
      channels: Number(clip.validation.metrics?.channels || 0),
      artifact: {
        filename: clip.artifact.filename,
        sha256: clip.artifact.sha256,
        bytes: clip.artifact.bytes,
        format: clip.artifact.format
      },
      provenance: clip.provenance,
      license: clip.license,
      qa: clip.validation.audioQa
    };
  });
  return {
    schema: SCHEMA,
    productionRunId,
    clips: normalized,
    unreal: {
      useInterchange: false,
      importer: "SoundWaveFactory",
      createSoundWaves: true,
      destination: "/Game/Comic30/Audio",
      preserveLoopMetadata: true
    },
    generatedAt: new Date().toISOString()
  };
}

function validateUnrealAudioHandoff(value) {
  const errors = [];
  if (value?.schema !== SCHEMA) errors.push("Audio handoff schema is invalid.");
  if (!value?.productionRunId) errors.push("Audio handoff production run identity is missing.");
  if (!Array.isArray(value?.clips) || !value.clips.length) errors.push("Audio handoff contains no clips.");
  for (const clip of value?.clips || []) {
    if (!clip?.id || !clip?.name || !clip?.kind || !clip?.artifact?.sha256 || !clip?.artifact?.bytes) errors.push("Audio handoff clip evidence is incomplete.");
    if (clip?.artifact?.format !== "wav" || clip?.qa?.passed !== true || Number(clip?.sampleRate || 0) < 44100 || ![1, 2].includes(Number(clip?.channels || 0))) errors.push(`${clip?.name || "Audio clip"} did not pass WAV production QA.`);
    if (clip?.license?.commercialUseAllowed !== true || !clip?.provenance?.model) errors.push(`${clip?.name || "Audio clip"} lacks commercial-use licensing or provenance.`);
  }
  if (value?.unreal?.createSoundWaves !== true || value?.unreal?.destination !== "/Game/Comic30/Audio") errors.push("Audio handoff does not request Unreal SoundWave creation in the Comic30 audio destination.");
  return { ok: errors.length === 0, errors: [...new Set(errors)] };
}

module.exports = { SCHEMA, createUnrealAudioHandoff, validateUnrealAudioHandoff };
