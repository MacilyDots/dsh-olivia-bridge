/* dsh-olivia-bridge — 歌单（「加播单」/「音乐桌面」）。
 *
 * 契约来自 feapp 0.0.9.627（见 HANDOVER §12.6）：
 *   POST /toy/addToPlaylist   {item_type, item_id} -> 回显完整条目
 *   POST /toy/delFromPlaylist {item_type, item_id} -> 任意
 *   GET  /toy/searchPlaylist  ?cursor=&page_size=  -> {list,total,hasMore,nextCursor}
 *
 * 为什么返回体必须字段齐全：
 *   1. 前端的列表映射是
 *        ee = q => q.itemType === pt.PGC_SONG ? q.songId : q.id
 *        tt = q => ({ id: ee(q), name: q.name, nameKey: q.nameKey, ... })
 *      —— `id` 由 **itemType** 决定。早期这里走空信封，`id` 全是 undefined，
 *      于是第二条加进去就被当成重复（「播单只能加一个」）。
 *   2. `createdAt` 必须是 **Unix 秒**。给毫秒或 ISO 字符串，界面上就是
 *      `Invalid Date`（音乐桌面那条 0:00 就是这么来的）。
 *   3. 条目要带 `videoUrl`，否则音乐桌面里点演奏没有媒体源。
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "./store.js";

const FILE = "playlist.json";

export class PlaylistStore {
  constructor({ onLog = () => {}, now = () => Date.now() } = {}) {
    this.onLog = onLog;
    this.now = now;
    this.dir = dataDir();
    this.file = join(this.dir, FILE);
    this.items = [];
    this.#load();
  }

  #load() {
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8"));
      this.items = Array.isArray(raw.items) ? raw.items : [];
    } catch {
      /* 首次运行没有文件 */
    }
  }

  #save() {
    try {
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(this.file, JSON.stringify({ items: this.items }, null, 2), "utf8");
    } catch (error) {
      this.onLog(`playlist: 保存失败 ${error?.message ?? error}`);
    }
  }

  #key(itemType, itemId) {
    return `${itemType}:${itemId}`;
  }

  /**
   * 加入歌单。同一个 (itemType,itemId) 幂等。
   * describe(itemId) 由宿主注入，用来补全曲目元数据（名字/媒体/时长）。
   */
  add({ itemType, itemId, describe }) {
    const key = this.#key(itemType, itemId);
    const existing = this.items.find((item) => this.#key(item.itemType, item.itemId) === key);
    if (existing) return existing;
    const meta = (typeof describe === "function" ? describe(itemId) : null) ?? {};
    const item = {
      itemType,
      itemId,
      songId: meta.songId ?? String(itemId),
      performanceId: meta.performanceId ?? "",
      name: meta.name ?? String(itemId),
      nameKey: meta.nameKey ?? String(itemId),
      iconUrl: meta.iconUrl ?? "",
      videoUrl: meta.videoUrl ?? "",
      videoByTodView: meta.videoByTodView,
      performanceType: meta.performanceType ?? "",
      duration: meta.duration ?? 0,
      // ⚠️ Unix 秒。前端直接 new Date(x*1000)，给毫秒会算出 Invalid Date。
      createdAt: Math.floor(this.now() / 1000),
    };
    this.items.unshift(item);
    this.#save();
    return item;
  }

  remove({ itemType, itemId }) {
    const key = this.#key(itemType, itemId);
    const before = this.items.length;
    this.items = this.items.filter((item) => this.#key(item.itemType, item.itemId) !== key);
    const removed = before - this.items.length;
    if (removed > 0) this.#save();
    return { ok: true, removed };
  }

  list({ pageSize = 200, cursor = 0 } = {}) {
    const size = Number(pageSize) > 0 ? Number(pageSize) : 200;
    const start = Number(cursor) > 0 ? Number(cursor) : 0;
    const slice = this.items.slice(start, start + size);
    const hasMore = start + size < this.items.length;
    return {
      list: slice,
      total: this.items.length,
      hasMore,
      nextCursor: hasMore ? start + size : 0,
    };
  }
}
