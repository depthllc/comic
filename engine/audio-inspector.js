"use strict";

function readFourCc(buffer, offset) {
  return buffer.toString("ascii", offset, offset + 4);
}

function decodeSample(buffer, offset, audioFormat, bitsPerSample) {
  if (audioFormat === 3 && bitsPerSample === 32) return buffer.readFloatLE(offset);
  if (audioFormat !== 1) throw new Error(`Unsupported WAV format tag ${audioFormat}.`);
  if (bitsPerSample === 16) return buffer.readInt16LE(offset) / 32768;
  if (bitsPerSample === 24) {
    let value = buffer.readUIntLE(offset, 3);
    if (value & 0x800000) value |= 0xff000000;
    return value / 8388608;
  }
  if (bitsPerSample === 32) return buffer.readInt32LE(offset) / 2147483648;
  throw new Error(`Unsupported PCM bit depth ${bitsPerSample}.`);
}

function inspectWavBuffer(buffer, options = {}) {
  const errors = [];
  const warnings = [];
  const minimumSampleRate = Math.max(8000, Number(options.minimumSampleRate || 44100));
  const expectedDuration = Number(options.expectedDurationSeconds || 0);
  const requireLoop = options.loop === true;
  if (!Buffer.isBuffer(buffer) || buffer.length < 44) {
    return { ok: false, errors: ["Audio artifact is not a complete WAV file."], warnings, format: null, metrics: {}, audioQa: { passed: false } };
  }
  if (readFourCc(buffer, 0) !== "RIFF" || readFourCc(buffer, 8) !== "WAVE") {
    return { ok: false, errors: ["Audio artifact is not a RIFF/WAVE file."], warnings, format: null, metrics: {}, audioQa: { passed: false } };
  }

  let format = null;
  let data = null;
  let cursor = 12;
  while (cursor + 8 <= buffer.length) {
    const id = readFourCc(buffer, cursor);
    const size = buffer.readUInt32LE(cursor + 4);
    const start = cursor + 8;
    const end = start + size;
    if (end > buffer.length) {
      errors.push(`WAV chunk ${id} extends beyond the artifact boundary.`);
      break;
    }
    if (id === "fmt " && size >= 16) {
      format = {
        audioFormat: buffer.readUInt16LE(start),
        channels: buffer.readUInt16LE(start + 2),
        sampleRate: buffer.readUInt32LE(start + 4),
        byteRate: buffer.readUInt32LE(start + 8),
        blockAlign: buffer.readUInt16LE(start + 12),
        bitsPerSample: buffer.readUInt16LE(start + 14)
      };
    } else if (id === "data" && !data) {
      data = { start, bytes: size };
    }
    cursor = end + (size % 2);
  }

  if (!format) errors.push("WAV artifact has no valid fmt chunk.");
  if (!data || data.bytes < 1) errors.push("WAV artifact has no audio data chunk.");
  if (errors.length) return { ok: false, errors, warnings, format, metrics: {}, audioQa: { passed: false } };

  const supported = (format.audioFormat === 1 && [16, 24, 32].includes(format.bitsPerSample))
    || (format.audioFormat === 3 && format.bitsPerSample === 32);
  if (!supported) errors.push(`WAV encoding ${format.audioFormat}/${format.bitsPerSample}-bit is unsupported; use PCM16/24/32 or Float32.`);
  if (![1, 2].includes(format.channels)) errors.push("WAV must contain one or two channels.");
  if (format.sampleRate < minimumSampleRate) errors.push(`WAV sample rate ${format.sampleRate} Hz is below the ${minimumSampleRate} Hz production floor.`);
  const bytesPerSample = format.bitsPerSample / 8;
  const expectedBlockAlign = format.channels * bytesPerSample;
  if (format.blockAlign !== expectedBlockAlign || data.bytes % expectedBlockAlign !== 0) errors.push("WAV block alignment is invalid.");
  if (errors.length) return { ok: false, errors, warnings, format, metrics: {}, audioQa: { passed: false } };

  const frameCount = Math.floor(data.bytes / format.blockAlign);
  const durationSeconds = frameCount / format.sampleRate;
  const maxFrames = 2_000_000;
  const stride = Math.max(1, Math.floor(frameCount / maxFrames));
  let samples = 0;
  let squared = 0;
  let sum = 0;
  let peak = 0;
  let clipped = 0;
  const first = new Array(format.channels).fill(0);
  const last = new Array(format.channels).fill(0);
  for (let frame = 0; frame < frameCount; frame += stride) {
    for (let channel = 0; channel < format.channels; channel += 1) {
      const offset = data.start + frame * format.blockAlign + channel * bytesPerSample;
      const value = decodeSample(buffer, offset, format.audioFormat, format.bitsPerSample);
      if (!Number.isFinite(value)) { errors.push("WAV contains a non-finite sample."); break; }
      if (frame === 0) first[channel] = value;
      last[channel] = value;
      const absolute = Math.abs(value);
      peak = Math.max(peak, absolute);
      if (absolute >= 0.999) clipped += 1;
      squared += value * value;
      sum += value;
      samples += 1;
    }
    if (errors.length) break;
  }
  const rms = samples ? Math.sqrt(squared / samples) : 0;
  const dcOffset = samples ? sum / samples : 0;
  const clippingRatio = samples ? clipped / samples : 0;
  const loopSeamDelta = Math.max(...first.map((value, index) => Math.abs(value - last[index])));

  if (durationSeconds < 0.1) errors.push("WAV duration is too short to be a production audio artifact.");
  if (expectedDuration > 0) {
    const tolerance = Math.max(0.25, expectedDuration * 0.2);
    if (Math.abs(durationSeconds - expectedDuration) > tolerance) errors.push(`WAV duration ${durationSeconds.toFixed(2)}s does not match the requested ${expectedDuration.toFixed(2)}s duration.`);
  }
  if (rms < 0.001 || peak < 0.005) errors.push("WAV is silent or below the usable signal floor.");
  if (clippingRatio > 0.01) errors.push(`WAV clipping ratio ${(clippingRatio * 100).toFixed(2)}% exceeds the 1% ceiling.`);
  if (Math.abs(dcOffset) > 0.1) errors.push("WAV DC offset exceeds the production threshold.");
  if (requireLoop && loopSeamDelta > 0.25) errors.push(`WAV loop seam delta ${loopSeamDelta.toFixed(3)} is likely audible.`);
  else if (requireLoop && loopSeamDelta > 0.08) warnings.push(`WAV loop seam delta ${loopSeamDelta.toFixed(3)} should be reviewed.`);

  const metrics = {
    frameCount,
    durationSeconds: Number(durationSeconds.toFixed(6)),
    sampleRate: format.sampleRate,
    channels: format.channels,
    bitsPerSample: format.bitsPerSample,
    rms: Number(rms.toFixed(6)),
    peak: Number(peak.toFixed(6)),
    clippingRatio: Number(clippingRatio.toFixed(8)),
    dcOffset: Number(dcOffset.toFixed(6)),
    loopSeamDelta: Number(loopSeamDelta.toFixed(6))
  };
  const passed = errors.length === 0;
  return {
    ok: passed,
    errors: [...new Set(errors)],
    warnings: [...new Set(warnings)],
    format: { container: "wav", codec: format.audioFormat === 3 ? "float" : "pcm", ...format },
    metrics,
    audioQa: { passed, signalPassed: rms >= 0.001 && peak >= 0.005, clippingPassed: clippingRatio <= 0.01, dcPassed: Math.abs(dcOffset) <= 0.1, loopPassed: !requireLoop || loopSeamDelta <= 0.25 }
  };
}

module.exports = { inspectWavBuffer };
