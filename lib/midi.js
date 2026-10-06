/* dsh-olivia-bridge — 「定制演奏」链路（MIDI 上传 → 生成 → 我的上传 → 播放）。
 *
 * 契约来自 feapp 0.0.9.627 主脚本（偏移见 HANDOVER §12）：
 *   POST /toy/genObjectUploadUrl {filename,type} -> {url,key,headers}
 *        客户端随后 `xhr.open("PUT", url)` + 逐个 setRequestHeader(headers) + xhr.send(File)
 *   POST /toy/midi/generate {midi_url}          -> {jobId, state:1}   ← 首答必须是「排队」
 *   GET  /toy/midi/getGenerateResult?job_id=    -> {jobId,state,info:{audioUrl,videoUrls[]}}
 *        前端只在 `state===3(Finished) && info.videoUrls.length` 时判定完成
 *   GET  /toy/midi/listJobs / batchGetResult / cancelGenerate / deleteJob
 *   GET  /toy/searchUserSongs                   -> {list:[{userSongId,...}],total,hasMore,nextCursor}
 *   GET  /toy/midi/media/<jobId>.wav            ← 媒体本体
 *
 * MIDI 解析与 WAV 合成移植自 Comma0103/Linli-Nocturne（MIT）的
 * `src/music/midi-manifest.js` + `src/music/audio-renderer.js`：
 * 纯 JS 正弦波叠加，不依赖任何外部二进制。**没有做 MP4 封装**（那一步他们用
 * ffmpeg，本机没有），所以现在给出去的是 WAV：前端试听用的是自己的音频组件，
 * 有机会直接播；原生 WebPlayer 是 <video>，多半播不了 —— 见 HANDOVER §12 的边界。
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { dataDir } from "./store.js";

const SAMPLE_RATE = 44100;
const DEFAULT_TEMPO = 500000;

/** 客户端数字状态（feapp `De` 枚举）。 */
const CLIENT_STATES = Object.freeze({
  queued: 1, pending: 1,
  processing: 2, running: 2,
  finished: 3,
  canceled: 4,
  failed: 5,
});

/* ── MIDI 解析 ─────────────────────────────────────────────────────── */

const HEADER = [0x4d, 0x54, 0x68, 0x64];
const readUInt32BE = (b, o) => (b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3];
const readUInt16BE = (b, o) => (b[o] << 8) | b[o + 1];

export function inspectMidi(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (bytes.length < 14 || !HEADER.every((v, i) => bytes[i] === v)) throw new Error("不是合法的 MIDI 文件（缺少 MThd 头）");
  const headerLength = readUInt32BE(bytes, 4);
  if (headerLength < 6 || bytes.length < 8 + headerLength) throw new Error("MIDI 头被截断");
  const format = readUInt16BE(bytes, 8);
  const tracks = readUInt16BE(bytes, 10);
  const ticksPerBeat = readUInt16BE(bytes, 12);
  if (format > 2 || tracks < 1 || ticksPerBeat === 0 || (ticksPerBeat & 0x8000)) throw new Error("不支持的 MIDI 时间基准");
  return { format, tracks, ticksPerBeat, byteLength: bytes.length };
}

function readVarLen(bytes, offset) {
  let value = 0;
  let cursor = offset;
  for (let count = 0; count < 4; count += 1) {
    if (cursor >= bytes.length) throw new Error("MIDI 变长字段被截断");
    const byte = bytes[cursor++];
    value = (value << 7) | (byte & 0x7f);
    if ((byte & 0x80) === 0) return { value, next: cursor };
  }
  throw new Error("非法的 MIDI 变长字段");
}

function readChunk(bytes, offset) {
  if (offset + 8 > bytes.length) throw new Error("MIDI 轨道块被截断");
  const type = String.fromCharCode(...bytes.slice(offset, offset + 4));
  const length = readUInt32BE(bytes, offset + 4);
  const start = offset + 8;
  const end = start + length;
  if (end > bytes.length) throw new Error("MIDI 轨道数据被截断");
  return { type, start, end, next: end };
}

export function parseMidi(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const info = inspectMidi(bytes);
  let cursor = 8 + readUInt32BE(bytes, 4);
  const events = [];
  for (let trackIndex = 0; trackIndex < info.tracks; trackIndex += 1) {
    const chunk = readChunk(bytes, cursor);
    if (chunk.type !== "MTrk") throw new Error(`意外的 MIDI 块: ${chunk.type}`);
    cursor = chunk.next;
    let offset = chunk.start;
    let tick = 0;
    let runningStatus = null;
    while (offset < chunk.end) {
      const delta = readVarLen(bytes, offset);
      tick += delta.value;
      offset = delta.next;
      let status = bytes[offset];
      if (status < 0x80) {
        if (runningStatus === null) throw new Error("MIDI 数据字节缺少 running status");
        status = runningStatus;
      } else {
        offset += 1;
        if (status < 0xf0) runningStatus = status;
      }
      if (status === 0xff) {
        if (offset >= chunk.end) throw new Error("MIDI meta 事件被截断");
        const metaType = bytes[offset++];
        const length = readVarLen(bytes, offset);
        offset = length.next + length.value;
        if (offset > chunk.end) throw new Error("MIDI meta 负载被截断");
        if (metaType === 0x2f) break;
        if (metaType === 0x51 && length.value === 3) {
          const start = length.next;
          events.push({ type: "tempo", track: trackIndex, tick, microsecondsPerBeat: (bytes[start] << 16) | (bytes[start + 1] << 8) | bytes[start + 2] });
        }
        continue;
      }
      if (status === 0xf0 || status === 0xf7) {
        const length = readVarLen(bytes, offset);
        offset = length.next + length.value;
        continue;
      }
      const command = status & 0xf0;
      const channel = status & 0x0f;
      const data1 = bytes[offset++];
      if (command === 0xc0 || command === 0xd0) continue;
      const data2 = bytes[offset++];
      if (command === 0x80 || (command === 0x90 && data2 === 0)) events.push({ type: "noteOff", track: trackIndex, channel, tick, note: data1, velocity: data2 });
      else if (command === 0x90) events.push({ type: "noteOn", track: trackIndex, channel, tick, note: data1, velocity: data2 });
      else if (command === 0xb0 && data1 === 64) events.push({ type: data2 >= 64 ? "sustainOn" : "sustainOff", track: trackIndex, channel, tick, value: data2 });
    }
  }
  events.sort((a, b) => a.tick - b.tick || a.track - b.track);
  return { ...info, events };
}

/* ── WAV 合成 ──────────────────────────────────────────────────────── */

const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

function collectNotes(parsed) {
  const notes = [];
  const active = new Map();
  const sustained = new Map();
  const pedal = new Map();
  let tempo = DEFAULT_TEMPO;
  let lastTick = 0;
  let elapsed = 0;

  const close = (key, end) => {
    const note = active.get(key);
    if (!note) return;
    notes.push({ ...note, end: Math.max(end, note.start + 0.01) });
    active.delete(key);
  };

  for (const event of parsed.events) {
    elapsed += ((event.tick - lastTick) / parsed.ticksPerBeat) * (tempo / 1_000_000);
    lastTick = event.tick;
    if (event.type === "tempo") { tempo = event.microsecondsPerBeat; continue; }
    const key = `${event.channel ?? 0}:${event.note ?? ""}`;
    if (event.type === "noteOn") {
      if (event.velocity === 0) { close(key, elapsed); continue; }
      if (active.has(key)) close(key, elapsed);
      active.set(key, { channel: event.channel, note: event.note, velocity: event.velocity, start: elapsed });
    } else if (event.type === "noteOff") {
      if (pedal.get(event.channel)) sustained.set(key, true);
      else close(key, elapsed);
    } else if (event.type === "sustainOn") {
      pedal.set(event.channel, true);
    } else if (event.type === "sustainOff") {
      pedal.set(event.channel, false);
      for (const pending of [...sustained.keys()]) {
        if (pending.startsWith(`${event.channel}:`)) { sustained.delete(pending); close(pending, elapsed); }
      }
    }
  }
  for (const key of [...active.keys()]) close(key, elapsed + 0.5);
  return { notes, duration: Math.max(elapsed + 0.5, 0.5) };
}

export function encodeWav(samples, sampleRate = SAMPLE_RATE) {
  const dataSize = samples.length * 2;
  const wav = Buffer.alloc(44 + dataSize);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + dataSize, 4);
  wav.write("WAVE", 8);
  wav.write("fmt ", 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(dataSize, 40);
  for (let index = 0; index < samples.length; index += 1) {
    wav.writeInt16LE(clamp(Math.round(samples[index] * 32767), -32768, 32767), 44 + index * 2);
  }
  return wav;
}

/** MIDI 字节 → WAV 字节。纯 JS：每个音符叠一个带包络的正弦波。 */
export function renderMidiToWav(buffer, { sampleRate = SAMPLE_RATE } = {}) {
  const parsed = parseMidi(buffer);
  const { notes, duration } = collectNotes(parsed);
  const sampleCount = Math.ceil(duration * sampleRate);
  const samples = new Float32Array(sampleCount);
  for (const note of notes) {
    const start = Math.floor(note.start * sampleRate);
    const end = Math.min(sampleCount, Math.ceil(note.end * sampleRate));
    const frequency = 440 * 2 ** ((note.note - 69) / 12);
    const amplitude = (note.velocity / 127) * 0.18;
    for (let index = start; index < end; index += 1) {
      const time = index / sampleRate - note.start;
      const release = note.end - index / sampleRate;
      const envelope = Math.min(1, time / 0.015, Math.max(0, release / 0.08));
      samples[index] += Math.sin(2 * Math.PI * frequency * time) * amplitude * envelope;
    }
  }
  for (let index = 0; index < samples.length; index += 1) samples[index] = clamp(samples[index], -0.95, 0.95);
  return { wav: encodeWav(samples, sampleRate), duration, noteCount: notes.length, parsed };
}

/* ── 任务存储 ──────────────────────────────────────────────────────── */

const JOB_FILE = "jobs.json";

/**
 * 找一个 ffmpeg。顺序：显式配置 > 环境变量 OLIVIA_FFMPEG > 桥数据目录自带 > PATH。
 *
 * 刻意**不**在启动时真跑一次转换来探测能力（那要几百毫秒，还会拖慢 DSH 启动），
 * 而是渲染时用一次、失败就降级：只影响「演奏」（原生 WebPlayer 是 <video>，
 * 播不了 WAV），「试听」走前端音频组件，用 WAV 本来就能播。
 *
 * 路径不写死 —— 别人的机器上 ffmpeg 从哪来的都有（随剪辑软件、主题引擎附带的，
 * 或者单独下载的），所以只认「配置 / 环境变量 / 桥自己的目录 / PATH」这四种来源。
 */
function resolveFfmpeg(configured, dataRoot) {
  const candidates = [
    configured,
    process.env.OLIVIA_FFMPEG,
    join(dataRoot, "ffmpeg", process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg"),
    "ffmpeg",
  ].filter((value) => typeof value === "string" && value !== "");
  for (const candidate of candidates) {
    if (candidate === "ffmpeg") return candidate; // 交给 PATH 解析
    try {
      if (existsSync(candidate)) return candidate;
    } catch {
      /* 路径非法就当没这个候选 */
    }
  }
  return null;
}

export class MidiJobStore {
  constructor({ onLog = () => {}, now = () => Date.now(), ffmpegPath = "" } = {}) {
    this.onLog = onLog;
    this.now = now;
    this.dir = join(dataDir(), "midi");
    this.file = join(this.dir, JOB_FILE);
    this.jobs = new Map();
    this.uploads = new Map();
    mkdirSync(this.dir, { recursive: true });
    this.ffmpegPath = resolveFfmpeg(ffmpegPath, dataDir());
    this.onLog(this.ffmpegPath
      ? `midi: ffmpeg = ${this.ffmpegPath}`
      : "midi: 没找到 ffmpeg，演奏只会拿到 WAV（原生 WebPlayer 播不了；试听不受影响）");
    this.#load();
    this.#backfillVideos();
  }

  #load() {
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8"));
      for (const job of raw.jobs ?? []) this.jobs.set(job.jobId, job);
    } catch {
      /* 首次运行没有文件 */
    }
  }

  #save() {
    try {
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(this.file, JSON.stringify({ jobs: [...this.jobs.values()] }, null, 2), "utf8");
    } catch (error) {
      this.onLog(`midi: 保存任务失败 ${error?.message ?? error}`);
    }
  }

  mediaPath(jobId, extension = "wav") {
    return join(this.dir, `${jobId}.${extension}`);
  }

  midiPath(key) {
    return join(this.dir, `${key}.mid`);
  }

  /* 上传第一步：给出客户端要 PUT 的地址 */
  createUpload({ filename = "upload.mid", uploadUrl = "http://127.0.0.1:8791" } = {}) {
    const key = `midi-${randomUUID()}`;
    this.uploads.set(key, { filename, createdAt: this.now() });
    return {
      url: `${uploadUrl}/toy/midi/upload/${key}`,
      key,
      filename,
      headers: { "content-type": "application/octet-stream" },
    };
  }

  receiveUpload(key, buffer) {
    const meta = this.uploads.get(key);
    if (!meta) throw new Error("unknown upload key");
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.midiPath(key), buffer);
    meta.receivedAt = this.now();
    meta.bytes = buffer.length;
    this.onLog(`midi: upload ${key} received (${buffer.length} bytes, ${meta.filename})`);
    return { key, filename: meta.filename, byteLength: buffer.length };
  }

  /** 创建任务。首答必须是 state:1（排队），前端据此开始轮询。 */
  generate({ midiUrl, filename = "", mediaBaseUrl = "http://127.0.0.1:8791" }) {
    const key = String(midiUrl ?? "");
    const meta = this.uploads.get(key);
    if (!meta) throw new Error("midi_not_found");
    const jobId = `job-${randomUUID()}`;
    const name = filename || meta.filename || "untitled";
    const job = {
      jobId,
      key,
      filename: name,
      name: name.replace(/\.[^.]+$/u, ""),
      nameKey: jobId,
      styleType: "solo",
      performanceType: "original",
      state: "pending",
      createdAt: this.now(),
      updatedAt: this.now(),
      mediaBaseUrl,
    };
    this.jobs.set(jobId, job);
    this.#save();
    this.onLog(`midi: job ${jobId} queued for ${name}`);
    // 同步渲染会把 HTTP 请求拖住（一首几分钟的曲子要好几秒），所以挪到下一个 tick。
    setImmediate(() => this.#render(jobId));
    return job;
  }

  #render(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) return;
    const started = this.now();
    try {
      job.state = "processing";
      const bytes = readFileSync(this.midiPath(job.key));
      const { wav, duration, noteCount } = renderMidiToWav(bytes);
      const wavPath = this.mediaPath(jobId, "wav");
      writeFileSync(wavPath, wav);
      job.state = "finished";
      job.duration = duration;
      job.noteCount = noteCount;
      job.mediaBytes = wav.length;
      job.updatedAt = this.now();
      // 演奏走原生 WebPlayer（<video>），播不了 WAV，所以再封一个音频-only MP4；
      // 试听仍用 WAV（前端音频组件已实测能播）。两条 URL 各走各的。
      job.hasVideo = this.#encodeMp4(wavPath, jobId);
      this.onLog(`midi: job ${jobId} finished (${noteCount} notes, ${duration.toFixed(1)}s audio${job.hasVideo ? ", mp4 ok" : ", no mp4"}, render ${this.now() - started}ms)`);
    } catch (error) {
      job.state = "failed";
      job.error = String(error?.message ?? error);
      job.updatedAt = this.now();
      this.onLog(`midi: job ${jobId} failed: ${job.error}`);
    }
    this.#save();
  }

  /** WAV → 音频-only MP4。失败只影响演奏，任务照样算完成。 */
  #encodeMp4(wavPath, jobId) {
    if (!this.ffmpegPath) return false;
    const mp4Path = this.mediaPath(jobId, "mp4");
    try {
      execFileSync(this.ffmpegPath, [
        "-hide_banner", "-loglevel", "error", "-y",
        "-i", wavPath,
        "-vn", "-c:a", "aac", "-b:a", "192k",
        "-movflags", "+faststart",
        "-f", "mp4", mp4Path,
      ], { stdio: "ignore", timeout: 120000 });
      return existsSync(mp4Path);
    } catch (error) {
      this.onLog(`midi: ffmpeg 封装失败 ${error?.message ?? error}`);
      return false;
    }
  }

  get(jobId) {
    return this.jobs.get(String(jobId ?? "")) ?? null;
  }

  /**
   * 给「MP4 支持之前生成的」老任务补一次封装（WAV 还在就补）。
   * 异步跑，不拖慢 DSH 启动；补不出来也不影响任务本身。
   */
  #backfillVideos() {
    if (!this.ffmpegPath) return;
    const pending = [...this.jobs.values()].filter((job) => job.state === "finished" && !job.hasVideo);
    if (pending.length === 0) return;
    setImmediate(() => {
      let changed = 0;
      for (const job of pending) {
        const wavPath = this.mediaPath(job.jobId, "wav");
        if (!existsSync(wavPath)) continue;
        job.hasVideo = this.#encodeMp4(wavPath, job.jobId);
        if (job.hasVideo) {
          changed += 1;
          this.onLog(`midi: job ${job.jobId} 补封 MP4`);
        }
      }
      if (changed > 0) this.#save();
    });
  }

  list({ pageSize = 20, cursor = 0 } = {}) {
    const size = Number(pageSize) > 0 ? Number(pageSize) : 20;
    const all = [...this.jobs.values()].sort((a, b) => b.createdAt - a.createdAt);
    const start = Number(cursor) > 0 ? Number(cursor) : 0;
    const slice = all.slice(start, start + size);
    return {
      list: slice,
      total: all.length,
      hasMore: start + size < all.length,
      nextCursor: start + size < all.length ? start + size : 0,
    };
  }

  batch(jobIds = []) {
    const ids = jobIds.length ? jobIds : [...this.jobs.keys()];
    return { list: ids.map((id) => this.jobs.get(String(id))).filter(Boolean) };
  }

  cancel(jobId) {
    const job = this.get(jobId);
    if (!job) return null;
    if (job.state === "pending" || job.state === "processing") {
      job.state = "canceled";
      job.updatedAt = this.now();
      this.#save();
    }
    return job;
  }

  delete(jobId) {
    const id = String(jobId ?? "");
    const job = this.jobs.get(id);
    if (!job) return false;
    this.jobs.delete(id);
    for (const ext of ["wav", "mp4"]) {
      const path = this.mediaPath(id, ext);
      try { if (existsSync(path)) unlinkSync(path); } catch { /* 删不掉就算了 */ }
    }
    this.#save();
    return true;
  }

  mediaBytes(jobId, extension = "wav") {
    const path = this.mediaPath(String(jobId ?? ""), extension);
    return existsSync(path) ? readFileSync(path) : null;
  }

  /** 已完成的曲目 = 「我的上传」列表。 */
  listUserSongs({ pageSize = 20, cursor = 0 } = {}) {
    const finished = [...this.jobs.values()]
      .filter((job) => job.state === "finished")
      .sort((a, b) => b.createdAt - a.createdAt);
    const size = Number(pageSize) > 0 ? Number(pageSize) : 20;
    const start = Number(cursor) > 0 ? Number(cursor) : 0;
    const slice = finished.slice(start, start + size);
    return {
      list: slice.map((job) => this.#toUserSong(job)),
      total: finished.length,
      hasMore: start + size < finished.length,
      nextCursor: start + size < finished.length ? start + size : 0,
    };
  }

  #toUserSong(job) {
    const base = job.mediaBaseUrl ?? "http://127.0.0.1:8791";
    const wav = `${base}/toy/midi/media/${job.jobId}.wav`;
    // 演奏/分享用 MP4（原生 <video> 只认视频容器），试听用 WAV。
    const video = job.hasVideo ? `${base}/toy/midi/media/${job.jobId}.mp4` : wav;
    return {
      userSongId: job.jobId,
      name: job.name,
      nameKey: job.nameKey,
      styleType: job.styleType,
      performanceType: job.performanceType,
      duration: job.duration ?? 0,
      createdAt: Math.floor((job.createdAt ?? this.now()) / 1000),
      iconUrl: "",
      audioUrl: wav,
      videoUrl: video,
      videoByTodView: { TOD1200: video, TOD1730: video, TOD2000: video },
      downloadState: 3,
    };
  }

  /** 客户端格式：state 用数字，完成时给 info.videoUrls（前端靠它判完成）。 */
  clientJob(job, mediaBaseUrl) {
    if (!job) return { jobId: "", state: CLIENT_STATES.failed, error: "job_not_found" };
    const base = mediaBaseUrl ?? job.mediaBaseUrl ?? "http://127.0.0.1:8791";
    const out = {
      jobId: job.jobId,
      filename: job.filename,
      state: CLIENT_STATES[job.state] ?? CLIENT_STATES.failed,
      createdAt: Math.floor((job.createdAt ?? 0) / 1000),
    };
    if (job.state === "finished") {
      const wav = `${base}/toy/midi/media/${job.jobId}.wav`;
      const video = job.hasVideo ? `${base}/toy/midi/media/${job.jobId}.mp4` : wav;
      out.info = { audioUrl: wav, videoUrls: [video], duration: job.duration ?? 0 };
    }
    if (job.error) out.error = job.error;
    return out;
  }

  dailyUsage() {
    const dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);
    const generatedToday = [...this.jobs.values()].filter((job) => (job.createdAt ?? 0) >= dayStart.getTime()).length;
    return { generatedToday, midiGeneratedToday: generatedToday, midiDailyLimit: 9999 };
  }
}
