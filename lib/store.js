/* 信件存储：一份 JSON 文件，写入走临时文件 + rename，避免半截文件。
 *
 * 数据结构与游戏客户端的字段对齐（时间戳为秒，与客户端一致）：
 *   letters[id] = {
 *     id, content, summary, stampId, createdAt, status, unread,
 *     replyText, replyType, repliedAt, failReason
 *   }
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const STATUS = { PENDING: 1, AUDITING: 2, LLM_PROCESSING: 3, REPLIED: 4, FAILED: 5 };
export const AUDIT = { PENDING: 1, PASSED: 2, REJECTED: 3 };
export const REPLY_TYPE = { NONE: 0, TEXT: 1, SPEECH: 2, MIX_PLAY: 3, MIX_SVS: 4 };

export function dataDir() {
  const home = process.env.DSH_HOME || join(homedir(), ".dsh");
  return join(home, "olivia-bridge");
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function summarize(text) {
  const clean = String(text).replace(/\s+/g, " ").trim();
  return clean.length > 50 ? clean.slice(0, 50) + "..." : clean;
}

export class LetterStore {
  constructor(file) {
    this.file = file || join(dataDir(), "letters.json");
    this.state = { seq: 0, letters: {}, profile: { uid: "linli-local", nickname: "" } };
    this.load();
  }

  load() {
    try {
      if (!existsSync(this.file)) return;
      const raw = readFileSync(this.file, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && parsed.letters) {
        this.state = {
          seq: Number(parsed.seq) || 0,
          letters: parsed.letters,
          profile: parsed.profile || { uid: "linli-local", nickname: "" },
        };
      }
    } catch {
      /* 损坏的存储不该让插件起不来：从空状态继续，旧文件保留在磁盘上 */
    }
  }

  save() {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = this.file + ".tmp";
      writeFileSync(tmp, JSON.stringify(this.state, null, 2), "utf8");
      renameSync(tmp, this.file);
    } catch {
      /* 落盘失败不影响内存中的本次回信 */
    }
  }

  create(content, stampId) {
    const id = String(++this.state.seq);
    const letter = {
      id,
      content,
      summary: summarize(content),
      stampId: stampId || "s1",
      createdAt: nowSeconds(),
      status: STATUS.PENDING,
      unread: false,
      replyText: "",
      replyType: REPLY_TYPE.NONE,
    };
    this.state.letters[id] = letter;
    this.save();
    return letter;
  }

  get(id) {
    return this.state.letters[String(id)] || null;
  }

  all() {
    return Object.values(this.state.letters);
  }

  /** 按创建时间倒序，与客户端列表顺序一致。 */
  sorted() {
    return this.all().sort((a, b) => b.createdAt - a.createdAt);
  }

  markProcessing(id) {
    const l = this.get(id);
    if (!l) return;
    l.status = STATUS.LLM_PROCESSING;
    this.save();
  }

  markReplied(id, replyText, replyType = REPLY_TYPE.TEXT) {
    const l = this.get(id);
    if (!l) return;
    l.status = STATUS.REPLIED;
    l.replyText = replyText;
    l.replyType = replyType;
    l.repliedAt = nowSeconds();
    l.unread = true;
    delete l.failReason;
    this.save();
  }

  markFailed(id, reason) {
    const l = this.get(id);
    if (!l) return;
    l.status = STATUS.FAILED;
    l.failReason = String(reason).slice(0, 300);
    this.save();
  }

  markRead(id) {
    const l = this.get(id);
    if (!l) return;
    l.unread = false;
    this.save();
  }

  reset(id) {
    const l = this.get(id);
    if (!l) return null;
    l.status = STATUS.PENDING;
    l.replyText = "";
    l.replyType = REPLY_TYPE.NONE;
    delete l.repliedAt;
    delete l.failReason;
    this.save();
    return l;
  }

  unreadCount() {
    return this.all().filter((l) => l.unread).length;
  }

  /** 玩家档案：客户端启动时要 uid / nickname / status 才肯进主界面。 */
  profile() {
    if (!this.state.profile) this.state.profile = { uid: "linli-local", nickname: "" };
    return this.state.profile;
  }

  rememberNickname(name) {
    const clean = String(name ?? "").trim();
    if (!clean) return this.profile();
    const p = this.profile();
    if (p.nickname !== clean) {
      p.nickname = clean;
      this.save();
    }
    return p;
  }

  /** signIn / getUserInfo 共用的载荷。 */
  userPayload() {
    const p = this.profile();
    const nickname = p.nickname || "旅人";
    return {
      uid: p.uid,
      status: 2,
      isNew: false,
      modelGatewayToken: null,
      userInfo: { nickname, gender: "unknown", birthdate: 0 },
    };
  }

  sentToday() {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const from = Math.floor(start.getTime() / 1000);
    return this.all().filter((l) => l.createdAt >= from).length;
  }

  /** 客户端 detail / list 共用的字段投影。 */
  toListItem(letter) {
    const replied = letter.status === STATUS.REPLIED;
    const item = {
      letterId: letter.id,
      isRead: letter.unread ? 0 : 1,
      letterStatus: letter.status,
      auditStatus: AUDIT.PASSED,
      summary: letter.summary,
      createdAt: letter.createdAt,
      replyType: letter.replyType ?? (replied ? REPLY_TYPE.TEXT : REPLY_TYPE.NONE),
    };
    if (replied) item.repliedAt = letter.repliedAt || letter.createdAt;
    if (letter.failReason) item.failReason = letter.failReason;
    return item;
  }

  toDetail(letter) {
    return {
      ...this.toListItem(letter),
      material: { stampId: letter.stampId || "s1", paperId: "" },
      content: letter.content,
      ...(letter.status === STATUS.REPLIED ? { replyText: letter.replyText || "" } : {}),
    };
  }
}
