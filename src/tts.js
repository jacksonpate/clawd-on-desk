// src/tts.js — ElevenLabs TTS for CLAWD-BOT terminal responses.
//
// Only fires for terminals whose ID is in TTS_TERMINAL_IDS.
// Voice + model are env-overridable so you can tune without editing code:
//   ELEVENLABS_API_KEY     (required — unset = TTS disabled)
//   ELEVENLABS_VOICE_ID    (default: UL7YtIO1odGIVqCrjI0U — Rich)
//   ELEVENLABS_MODEL       (default: eleven_flash_v2_5)
//   CLAWD_TTS_TERMINALS    (default: "t3,t4" — which terminal IDs read aloud)
//   CLAWD_TTS_MAX_CHARS    (default: 600 — cap to keep replies snappy)

"use strict";

const path = require("path");
const fs = require("fs");
const os = require("os");
const https = require("https");
const { spawn } = require("child_process");
const { app } = require("electron");

const TTS_VOICE = process.env.ELEVENLABS_VOICE_ID || "UL7YtIO1odGIVqCrjI0U";
const TTS_MODEL = process.env.ELEVENLABS_MODEL    || "eleven_flash_v2_5";
const TTS_KEY   = process.env.ELEVENLABS_API_KEY  || "";
const TTS_TERMINAL_IDS = (process.env.CLAWD_TTS_TERMINALS || "t3,t4")
  .split(",").map(s => s.trim()).filter(Boolean);
const MAX_CHARS = parseInt(process.env.CLAWD_TTS_MAX_CHARS || "600", 10);

function shouldSpeak(terminalId) {
  return TTS_KEY && TTS_TERMINAL_IDS.includes(terminalId);
}

function cleanForSpeech(text) {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^#+\s*/gm, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function fetchMp3(text) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ text, model_id: TTS_MODEL });
    const req = https.request({
      method: "POST",
      hostname: "api.elevenlabs.io",
      path: `/v1/text-to-speech/${TTS_VOICE}`,
      headers: {
        "xi-api-key": TTS_KEY,
        "Content-Type": "application/json",
        "Accept": "audio/mpeg",
        "Content-Length": Buffer.byteLength(body),
      },
      timeout: 30_000,
    }, (res) => {
      if (res.statusCode !== 200) {
        const err = [];
        res.on("data", c => err.push(c));
        res.on("end", () => reject(new Error(`ElevenLabs ${res.statusCode}: ${Buffer.concat(err).toString()}`)));
        return;
      }
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("ElevenLabs timeout")));
    req.write(body);
    req.end();
  });
}

function playMp3Detached(filePath) {
  if (process.platform !== "win32") {
    // Best-effort cross-platform: spawn afplay/mpv if present.
    const cmd = process.platform === "darwin" ? "afplay" : "mpv";
    spawn(cmd, [filePath], { detached: true, stdio: "ignore" }).unref();
    return;
  }
  // Windows — use PresentationCore via a detached PowerShell so this thread is fast.
  const psCmd = `Add-Type -AssemblyName PresentationCore; ` +
    `$p = New-Object System.Windows.Media.MediaPlayer; ` +
    `$p.Open([Uri]::new('${filePath.replace(/'/g, "''")}')); ` +
    `$p.Play(); ` +
    `Start-Sleep -Milliseconds 200; ` +
    `while (-not $p.NaturalDuration.HasTimeSpan) { Start-Sleep -Milliseconds 50 }; ` +
    `Start-Sleep -Milliseconds ([int]$p.NaturalDuration.TimeSpan.TotalMilliseconds + 300); ` +
    `$p.Stop(); $p.Close(); ` +
    `Remove-Item -LiteralPath '${filePath.replace(/'/g, "''")}' -Force -ErrorAction SilentlyContinue`;
  spawn("powershell.exe", ["-NoProfile", "-WindowStyle", "Hidden", "-Command", psCmd], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  }).unref();
}

let speakInflight = Promise.resolve();

async function speakForTerminal(terminalId, text) {
  if (!shouldSpeak(terminalId)) return;
  let clean = cleanForSpeech(text || "");
  if (!clean) return;
  if (clean.length > MAX_CHARS) clean = clean.slice(0, MAX_CHARS) + ".";

  // Serialize per-process so two terminals don't yell at the same time.
  speakInflight = speakInflight.then(async () => {
    try {
      const mp3 = await fetchMp3(clean);
      const tmpDir = (app && app.getPath("temp")) || os.tmpdir();
      const file = path.join(tmpDir, `clawd-tts-${Date.now()}-${Math.random().toString(36).slice(2,8)}.mp3`);
      fs.writeFileSync(file, mp3);
      playMp3Detached(file);
    } catch (e) {
      console.error(`[tts] ${terminalId}:`, e.message);
    }
  }, () => {});
  return speakInflight;
}

module.exports = { speakForTerminal, shouldSpeak, TTS_TERMINAL_IDS };
