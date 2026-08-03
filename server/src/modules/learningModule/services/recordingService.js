const axios = require("axios");

/**
 * Bridge to the attendance module's class recordings.
 *
 * The recordings are produced by the RTSP recorder in the attendance module and
 * physically live on the ML service's disk (see cameraController.downloadAudio
 * — Node never keeps a local copy). This module therefore talks to the same
 * ML service, reusing the shared-secret axios interceptor that
 * attendanceModule/controllers/mlServiceAuth.js registers at boot, rather than
 * duplicating the recorder or its auth.
 */

const ML_URL = () => process.env.ML_SERVICE_URL || "http://localhost:8500";

/** Every recording the attendance recorder currently knows about. */
async function listRecordings() {
  const { data } = await axios.get(`${ML_URL()}/recordings`, { timeout: 8000 });
  return Array.isArray(data) ? data : [];
}

/** Only finished recordings that actually carry an audio track. */
async function listUsableRecordings() {
  const all = await listRecordings();
  return all.filter(
    (rec) => rec.status === "done" && String(rec.format || "video+audio").includes("audio"),
  );
}

/** Streams the extracted mp3 for a recording; ffmpeg runs on the ML service. */
async function fetchAudioStream(filename) {
  const safe = require("path").basename(String(filename || ""));
  const upstream = await axios.get(`${ML_URL()}/recordings/${encodeURIComponent(safe)}/audio`, {
    responseType: "stream",
    timeout: 60000,
  });
  return { stream: upstream.data, filename: safe.replace(/\.mp4$/i, ".mp3") };
}

/**
 * Speech-to-text.
 *
 * LM_TRANSCRIBE_URL should point at any endpoint that accepts
 * `{ audioUrl | filename }` and returns `{ text, language?, segments? }` — a
 * Whisper wrapper on the ML host is the intended deployment. Until one is
 * configured the caller gets a clear, actionable error and the UI falls back to
 * pasting/uploading a transcript by hand, which keeps the whole pipeline usable.
 */
function isTranscriptionConfigured() {
  return Boolean(process.env.LM_TRANSCRIBE_URL);
}

async function transcribeRecording({ filename, audioUrl, language }) {
  if (!isTranscriptionConfigured()) {
    const error = new Error(
      "Automatic transcription is not configured on this server. Set LM_TRANSCRIBE_URL, " +
        "or paste/upload the transcript manually.",
    );
    error.status = 501;
    throw error;
  }

  const { data } = await axios.post(
    process.env.LM_TRANSCRIBE_URL,
    { filename, audioUrl, language: language || "en" },
    { timeout: Number(process.env.LM_TRANSCRIBE_TIMEOUT_MS || 900000) },
  );

  const text = data?.text || data?.transcript || "";
  if (!text) throw new Error("The transcription service returned no text.");

  return {
    text,
    language: data?.language || language || "en",
    segments: Array.isArray(data?.segments)
      ? data.segments.map((s) => ({
          start: Number(s.start) || 0,
          end: Number(s.end) || 0,
          text: String(s.text || ""),
          speaker: String(s.speaker || ""),
        }))
      : [],
    provider: data?.provider || "external",
    durationSec: Number(data?.duration) || 0,
  };
}

module.exports = {
  listRecordings,
  listUsableRecordings,
  fetchAudioStream,
  transcribeRecording,
  isTranscriptionConfigured,
};
