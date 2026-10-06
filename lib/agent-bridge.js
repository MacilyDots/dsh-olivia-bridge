/* agent 桥：把一封来信投进一个持久的 DSH agent 会话，等她回信。
 *
 * 会话本身就是林离的记忆——每封信都进同一个 session，历史自然连续，
 * 不需要额外的记忆数据库。插件只负责：建会话、投递、等空闲、取最后一条
 * assistant 文本。
 *
 * 刻意不 import 任何 @deepseek-ai/* 包：插件零依赖，服务全部从 ctx 上取，
 * 这样在 profile 的 pnpm 结构下不会出现解析不到依赖的问题。
 */
import { randomUUID } from "node:crypto";

const PLUGIN_NAME = "dsh-olivia-bridge";

/** 深冻结：官方 createMessage 会 deepFreeze(structuredClone(...))，消息进 inbox 前必须不可变。 */
function freezeDeep(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value)) freezeDeep(inner);
  }
  return value;
}

/** 构造一条合法的 user 消息。两个硬性要求（都踩过）：
 *   1. id 必需 —— 缺了 inbox 会静默丢弃；
 *   2. source.kind 必须是「生产者自有」的名字，v4 会话格式明确拒绝笼统的 "plugin"
 *      （见 dsh-session-format-v3-to-v4 的 source() 校验），官方迁移规则为 `plugin:<插件名>`。
 */
function userMessage(text) {
  return freezeDeep({
    id: randomUUID(),
    content: [{ type: "text", text }],
    source: { kind: `plugin:${PLUGIN_NAME}` },
  });
}

/** 从消息块里取纯文本。 */
function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
}

export class AgentBridge {
  /**
   * @param ctx cordis 上下文（插件 apply 的那个）
   * @param options { presetId, provider, model, workspacePath, sessionId, onLog }
   */
  constructor(ctx, options = {}) {
    this.ctx = ctx;
    this.options = options;
    this.handle = null;
    // 固定 id：DSH 重启后能 resume 回同一个会话，她的记忆才跨重启连续
    this.sessionId = options.sessionId || "olivia-letterbox";
    this.creating = null;
    this.queue = Promise.resolve();
    this.onLog = options.onLog || (() => {});
    this.presetActive = false;
    this.firstTurn = true;
  }

  /** cordis 服务取用：ctx.get(name) 与属性访问两条路都试。 */
  #service(name) {
    const { ctx } = this;
    try {
      const viaGet = typeof ctx.get === "function" ? ctx.get(name) : undefined;
      if (viaGet) return viaGet;
    } catch {
      /* 服务未注册时 get 可能抛错 */
    }
    return ctx[name] ?? null;
  }

  /** 惰性建会话；并发调用共享同一次创建。 */
  async ensureSession() {
    if (this.handle) return this.handle;
    if (this.creating) return this.creating;
    this.creating = this.#create().finally(() => {
      this.creating = null;
    });
    return this.creating;
  }

  async #create() {
    const { ctx } = this;
    const agents = this.#service("agents");
    if (!agents) throw new Error("dsh-olivia-bridge: agent service (ctx.agents) is unavailable");

    // 模型路由：没有显式配置就跟 DSH 的默认模型。
    // 官方 webhook 也这么做 —— agent 拿不到 provider/model 就发不出模型请求，
    // 表现是建完会话立刻 idle、零消息（正是这次踩到的坑）。
    const selection = this.#service("agentDefaultModel")?.currentSelection?.() ?? {};
    const provider = this.options.provider || selection.provider;
    const model = this.options.model || selection.model;
    const agentOptions = {};
    if (provider) agentOptions.provider = provider;
    if (model) agentOptions.model = model;
    this.onLog(`model route: ${provider || "?"}/${model || "?"}`);

    const presets = this.#service("agentPresets");
    const presetId = this.options.presetId;
    let preset = null;
    if (presets && presetId) {
      // preset 没注册（profile 配置树尚未重载）不是致命错误：
      // 退回"人格随首封信进会话"，回信照常工作。
      // 注册表按 config.id 索引，而行 id 惯例是 `preset-<config.id>`，两种写法都试。
      const candidates = [presetId, `preset-${presetId}`, presetId.replace(/^preset-/, "")];
      for (const id of candidates) {
        try {
          const found = await presets.resolve(id);
          if (found) {
            preset = found;
            await presets.acquireScope(found.id);
            this.onLog(`preset resolved as "${id}"`);
            break;
          }
        } catch {
          /* 换下一个候选 */
        }
      }
      if (!preset) this.onLog(`preset "${presetId}" unavailable — falling back to inline persona`);
    }

    const setup = async (agentCtx) => {
      if (presets && preset) {
        await presets.mount(agentCtx, preset.id);
      }
    };

    this.onLog(`creating session ${this.sessionId}${preset ? ` with preset ${preset.id}` : " (no preset)"}`);

    // 照 dsh-webhook 的做法：先把会话挂进一个 workspace，再建 agent。
    // 缺这一步时 agent 可能建得出来却不会被真正驱动（实测 whenIdle 立刻返回、零消息）。
    let workspace = null;
    try {
      const registry = this.#service("workspaceRegistry");
      if (registry) {
        workspace = await registry.create(this.options.workspacePath || process.cwd());
        this.onLog(`workspace ready: ${workspace?.path ?? "?"}`);
      }
    } catch (error) {
      this.onLog(`workspace create skipped: ${String(error?.message ?? error)}`);
      workspace = null;
    }

    this.handle = null;
    const meta = {
      cwd: workspace?.path || this.options.workspacePath || process.cwd(),
      ...(preset ? { agentPreset: preset.id } : {}),
    };

    // 先试 resume：固定 sessionId 才能让她在 DSH 重启后还记得之前那些信。
    try {
      this.handle = await agents.resume({ sessionId: this.sessionId, meta, agentOptions, setup });
      this.onLog(`resumed existing session ${this.sessionId}`);
    } catch (resumeError) {
      this.onLog(`resume skipped: ${String(resumeError?.message ?? resumeError).slice(0, 140)}`);
    }

    if (!this.handle) {
      try {
        this.handle = await agents.create({ sessionId: this.sessionId, meta, agentOptions, setup });
      } catch (createError) {
        // id 被占用又 resume 不了：退化成一次性会话，至少这一轮能回信
        this.onLog(`create failed on fixed id (${String(createError?.message ?? createError).slice(0, 120)}) — using a fresh id`);
        this.sessionId = `olivia-letterbox-${randomUUID()}`;
        this.handle = await agents.create({ sessionId: this.sessionId, meta, agentOptions, setup });
      }
    }
    this.onLog(`session ready: ${this.sessionId}`);

    try {
      if (workspace) await workspace.attachSession(this.sessionId);
      this.onLog("session attached to workspace");
    } catch (error) {
      this.onLog(`workspace attach skipped: ${String(error?.message ?? error)}`);
    }

    // 权限预设：官方 webhook 在建会话后立刻 set 一次。没配置就依次试几个常见 id。
    try {
      const perms = this.#service("permissionPresets");
      if (perms) {
        const candidates = [
          this.options.permissionPreset,
          "danger-full-access",
          "workspace-write",
          "standard",
          "default",
        ].filter(Boolean);
        for (const id of candidates) {
          try {
            perms.resolve(id);
            perms.set(this.handle.agent.session, id);
            this.onLog(`permission preset set: ${id}`);
            break;
          } catch {
            /* 换下一个候选 */
          }
        }
      }
    } catch (error) {
      this.onLog(`permission preset skipped: ${String(error?.message ?? error)}`);
    }

    this.presetActive = Boolean(preset);
    return this.handle;
  }

  /** 投递一封来信并等待回信文本。同一时刻只处理一封。 */
  ask(letterText) {
    const run = async () => {
      // preset 没挂上时，人格只能随首封信一起进去，否则她会以默认身份说话。
      const text = this.firstTurn && !this.presetActive ? this.options.wrapFirstLetter(letterText) : letterText;
      this.firstTurn = false;
      try {
        const handle = await this.ensureSession();
        const agent = handle.agent;
        const before = this.#assistantCount(agent);
        agent.followup(userMessage(text));
        // followup 只负责排队 + 异步唤醒驱动器：紧接着 whenIdle() 会在 agent
        // 还没醒时就返回（实测整轮只花 168ms、零消息）。改成先等 assistant
        // 消息真的落地，再等它停稳。
        const timeoutMs = this.options.replyTimeoutMs || 120000;
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline && this.#assistantCount(agent) <= before) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
        try {
          await agent.whenIdle();
        } catch {
          /* 即使等待超时，也要把已经产出的文本取走 */
        }
        const reply = this.#lastAssistantText(agent, before);
        if (!reply) {
          const diag = this.diagnose();
          throw new Error(
            `agent produced no assistant text (messages=${diag.messageCount ?? "?"} assistants=${diag.assistantCount ?? "?"} status=${JSON.stringify(diag.status) ?? "?"})`,
          );
        }
        return reply;
      } catch (error) {
        if (!this.options.llmFallback) throw error;
        this.onLog(`agent path failed (${String(error?.message ?? error)}) — falling back to direct llm`);
        return await this.#llmReply(text);
      }
    };
    // 串行化：会话历史是共享的，两封信同时投递会互相穿插
    const chained = this.queue.then(run, run);
    this.queue = chained.then(
      () => undefined,
      () => undefined,
    );
    return chained;
  }

  #messages(agent) {
    try {
      const session = agent.session;
      if (!session || typeof session.deriveMessages !== "function") return [];
      return session.deriveMessages() || [];
    } catch {
      return [];
    }
  }

  #assistantCount(agent) {
    return this.#messages(agent).filter((m) => m.role === "assistant").length;
  }

  /** 取本轮新增的最后一条 assistant 文本；没有新增就取全历史最后一条。 */
  #lastAssistantText(agent, previousCount) {
    const messages = this.#messages(agent);
    const assistants = messages.filter((m) => m.role === "assistant");
    if (assistants.length === 0) return "";
    const fresh = assistants.slice(previousCount);
    const pick = (fresh.length > 0 ? fresh : assistants).at(-1);
    return textOf(pick?.content).trim();
  }

  /** 诊断快照：给 /olivia/diag 用，排查「会话建了但没有 assistant 文本」这类问题。 */
  diagnose() {
    const handle = this.handle;
    if (!handle) return { session: null, note: "no session created yet" };
    const agent = handle.agent;
    const session = agent?.session;
    const info = { sessionId: session?.id ?? this.sessionId, presetActive: this.presetActive };
    try {
      info.agentKeys = Object.keys(agent ?? {}).slice(0, 30);
    } catch {
      /* 取不到就算了 */
    }
    try {
      info.sessionMethods = Object.getOwnPropertyNames(Object.getPrototypeOf(session ?? {})).slice(0, 60);
    } catch {
      /* 同上 */
    }
    try {
      const messages = session?.deriveMessages?.() ?? [];
      info.messageCount = messages.length;
      info.assistantCount = messages.filter((m) => m?.role === "assistant").length;
      info.roles = messages.map((m) => m?.role);
      const last = messages.at(-1);
      info.lastMessage = last ? { role: last.role, contentTypes: (last.content ?? []).map((c) => c?.type) } : null;
    } catch (error) {
      info.deriveError = String(error?.message ?? error);
    }
    try {
      info.status = agent?.status ?? null;
      info.phase = agent?.phase ?? null;
      const inbox = agent?.inbox;
      info.inbox = inbox
        ? { nextTurn: inbox.nextTurn?.length ?? null, nextStep: inbox.nextStep?.length ?? null }
        : null;
    } catch {
      /* 同上 */
    }
    return info;
  }

  /** 诊断：投一条消息并回报全过程快照，用来定位「会话建了但没人跑」。 */
  async probe(text) {
    const handle = await this.ensureSession();
    const agent = handle.agent;
    const before = this.diagnose();
    const started = Date.now();
    agent.followup(userMessage(text || "（诊断）你在吗？"));
    await agent.whenIdle();
    const after = this.diagnose();
    return {
      elapsedMs: Date.now() - started,
      before,
      after,
      reply: this.#lastAssistantText(agent, before.assistantCount ?? 0),
    };
  }

  /** 兜底路径：agent 会话跑不起来时，直接用 LLM 服务生成一封回信。 */
  async #llmReply(userText) {
    const llm = this.#service("llm");
    if (!llm) throw new Error("llm service unavailable");
    const selection = this.#service("agentDefaultModel")?.currentSelection?.() ?? {};
    const provider = this.options.provider || selection.provider;
    const model = this.options.model || selection.model;
    if (!provider || !model) throw new Error("no provider/model configured for llm fallback");

    const messages = [
      { role: "system", content: [{ type: "text", text: this.options.systemPrompt || "" }] },
      { role: "user", content: [{ type: "text", text: userText }] },
    ];
    let out = "";
    for await (const chunk of llm.stream({ provider, model, messages })) {
      if (chunk?.type === "text-delta" && typeof chunk.text === "string") out += chunk.text;
      else if (chunk?.type === "text-delta" && typeof chunk.delta === "string") out += chunk.delta;
      if (chunk?.type === "finish" && chunk.kind === "error") {
        throw new Error(`llm stream failed: ${JSON.stringify(chunk.failure ?? {}).slice(0, 200)}`);
      }
    }
    const text = out.trim();
    if (!text) throw new Error("llm produced no text");
    return text;
  }

  async dispose() {
    if (!this.handle) return;
    try {
      await this.handle.dispose();
    } catch (error) {
      this.onLog(`dispose failed: ${String(error?.message ?? error)}`);
    }
    this.handle = null;
  }
}
