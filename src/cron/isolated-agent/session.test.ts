import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";

vi.mock("../../config/sessions/store-load.js", () => ({
  loadSessionStore: vi.fn(),
}));

vi.mock("../../config/sessions/paths.js", () => ({
  resolveStorePath: vi.fn().mockReturnValue("/tmp/test-store.json"),
}));

vi.mock("../../config/sessions/reset-policy.js", () => ({
  evaluateSessionFreshness: vi.fn().mockReturnValue({ fresh: true }),
  resolveSessionResetPolicy: vi.fn().mockReturnValue({ mode: "idle", idleMinutes: 60 }),
}));

vi.mock("../../agents/bootstrap-cache.js", () => ({
  clearBootstrapSnapshot: vi.fn(),
  clearBootstrapSnapshotOnSessionRollover: vi.fn(({ sessionKey, previousSessionId }) => {
    if (sessionKey && previousSessionId) {
      clearBootstrapSnapshot(sessionKey);
    }
  }),
}));

import { clearBootstrapSnapshot } from "../../agents/bootstrap-cache.js";
import { evaluateSessionFreshness } from "../../config/sessions/reset-policy.js";
import { loadSessionStore } from "../../config/sessions/store-load.js";
import { resolveCronSession } from "./session.js";

const NOW_MS = 1_737_600_000_000;

type SessionStore = ReturnType<typeof loadSessionStore>;
type SessionStoreEntry = SessionStore[string];
type MockSessionStoreEntry = Partial<SessionStoreEntry>;

function resolveWithStoredEntry(params?: {
  sessionKey?: string;
  entry?: MockSessionStoreEntry;
  forceNew?: boolean;
  fresh?: boolean;
  payloadModel?: string;
  isCronOwnedSession?: boolean;
}) {
  const sessionKey = params?.sessionKey ?? "webhook:stable-key";
  const store: SessionStore = params?.entry
    ? ({ [sessionKey]: params.entry as SessionStoreEntry } as SessionStore)
    : {};
  vi.mocked(loadSessionStore).mockReturnValue(store);
  vi.mocked(evaluateSessionFreshness).mockReturnValue({ fresh: params?.fresh ?? true });

  return resolveCronSession({
    cfg: {} as OpenClawConfig,
    sessionKey,
    agentId: "main",
    nowMs: NOW_MS,
    forceNew: params?.forceNew,
    payloadModel: params?.payloadModel,
    isCronOwnedSession: params?.isCronOwnedSession,
  });
}

describe("resolveCronSession", () => {
  beforeEach(() => {
    vi.mocked(clearBootstrapSnapshot).mockReset();
  });

  it("preserves modelOverride and providerOverride from existing session entry", () => {
    const result = resolveWithStoredEntry({
      sessionKey: "agent:main:cron:test-job",
      entry: {
        sessionId: "old-session-id",
        updatedAt: 1000,
        modelOverride: "deepseek-v3-4bit-mlx",
        providerOverride: "inferencer",
        thinkingLevel: "high",
        model: "kimi-code",
      },
    });

    expect(result.sessionEntry.modelOverride).toBe("deepseek-v3-4bit-mlx");
    expect(result.sessionEntry.providerOverride).toBe("inferencer");
    expect(result.sessionEntry.thinkingLevel).toBe("high");
    // The model field (last-used model) should also be preserved
    expect(result.sessionEntry.model).toBe("kimi-code");
  });

  it("handles missing modelOverride gracefully", () => {
    const result = resolveWithStoredEntry({
      sessionKey: "agent:main:cron:test-job",
      entry: {
        sessionId: "old-session-id",
        updatedAt: 1000,
        model: "claude-opus-4-6",
      },
    });

    expect(result.sessionEntry.modelOverride).toBeUndefined();
    expect(result.sessionEntry.providerOverride).toBeUndefined();
  });

  it("handles no existing session entry", () => {
    const result = resolveWithStoredEntry({
      sessionKey: "agent:main:cron:new-job",
    });

    expect(result.sessionEntry.modelOverride).toBeUndefined();
    expect(result.sessionEntry.providerOverride).toBeUndefined();
    expect(result.sessionEntry.model).toBeUndefined();
    expect(result.isNewSession).toBe(true);
  });

  // New tests for session reuse behavior (#18027)
  describe("session reuse for webhooks/cron", () => {
    it("reuses existing sessionId when session is fresh", () => {
      const result = resolveWithStoredEntry({
        entry: {
          sessionId: "existing-session-id-123",
          updatedAt: NOW_MS - 1000,
          systemSent: true,
        },
        fresh: true,
      });

      expect(result.sessionEntry.sessionId).toBe("existing-session-id-123");
      expect(result.isNewSession).toBe(false);
      expect(result.previousSessionId).toBeUndefined();
      expect(result.systemSent).toBe(true);
      expect(clearBootstrapSnapshot).not.toHaveBeenCalled();
    });

    it("creates new sessionId when session is stale", () => {
      const result = resolveWithStoredEntry({
        entry: {
          sessionId: "old-session-id",
          updatedAt: NOW_MS - 86_400_000, // 1 day ago
          systemSent: true,
          modelOverride: "gpt-4.1-mini",
          providerOverride: "openai",
          sendPolicy: "allow",
        },
        fresh: false,
      });

      expect(result.sessionEntry.sessionId).not.toBe("old-session-id");
      expect(result.isNewSession).toBe(true);
      expect(result.previousSessionId).toBe("old-session-id");
      expect(result.systemSent).toBe(false);
      expect(result.sessionEntry.modelOverride).toBe("gpt-4.1-mini");
      expect(result.sessionEntry.providerOverride).toBe("openai");
      expect(result.sessionEntry.sendPolicy).toBe("allow");
      expect(clearBootstrapSnapshot).toHaveBeenCalledWith("webhook:stable-key");
    });

    it("creates new sessionId when forceNew is true", () => {
      const result = resolveWithStoredEntry({
        entry: {
          sessionId: "existing-session-id-456",
          updatedAt: NOW_MS - 1000,
          systemSent: true,
          modelOverride: "sonnet-4",
          providerOverride: "anthropic",
        },
        fresh: true,
        forceNew: true,
      });

      expect(result.sessionEntry.sessionId).not.toBe("existing-session-id-456");
      expect(result.isNewSession).toBe(true);
      expect(result.previousSessionId).toBe("existing-session-id-456");
      expect(result.systemSent).toBe(false);
      expect(result.sessionEntry.modelOverride).toBe("sonnet-4");
      expect(result.sessionEntry.providerOverride).toBe("anthropic");
      expect(clearBootstrapSnapshot).toHaveBeenCalledWith("webhook:stable-key");
    });

    it("clears stale sessionFile when forceNew rolls to a fresh session", () => {
      const result = resolveWithStoredEntry({
        entry: {
          sessionId: "existing-session-id-456",
          updatedAt: NOW_MS - 1000,
          sessionFile: "/tmp/stale-session.jsonl",
          modelOverride: "sonnet-4",
        },
        fresh: true,
        forceNew: true,
      });

      expect(result.sessionEntry.sessionId).not.toBe("existing-session-id-456");
      expect(result.isNewSession).toBe(true);
      expect(result.sessionEntry.sessionFile).toBeUndefined();
      expect(result.sessionEntry.modelOverride).toBe("sonnet-4");
    });

    it("clears delivery routing metadata and deliveryContext when forceNew is true", () => {
      const result = resolveWithStoredEntry({
        entry: {
          sessionId: "existing-session-id-789",
          updatedAt: NOW_MS - 1000,
          systemSent: true,
          lastChannel: "slack" as never,
          lastTo: "channel:C0XXXXXXXXX",
          lastAccountId: "acct-123",
          lastThreadId: "1737500000.123456",
          deliveryContext: {
            channel: "slack",
            to: "channel:C0XXXXXXXXX",
            threadId: "1737500000.123456",
          },
          modelOverride: "gpt-5.4",
        },
        fresh: true,
        forceNew: true,
      });

      expect(result.isNewSession).toBe(true);
      // Delivery routing state must be cleared to prevent thread leaking.
      // deliveryContext must also be cleared because normalizeSessionEntryDelivery
      // repopulates lastThreadId from deliveryContext.threadId on store writes.
      expect(result.sessionEntry.lastChannel).toBeUndefined();
      expect(result.sessionEntry.lastTo).toBeUndefined();
      expect(result.sessionEntry.lastAccountId).toBeUndefined();
      expect(result.sessionEntry.lastThreadId).toBeUndefined();
      expect(result.sessionEntry.deliveryContext).toBeUndefined();
      // Per-session overrides must be preserved
      expect(result.sessionEntry.modelOverride).toBe("gpt-5.4");
    });

    it("clears stale run-scoped state when forceNew rolls to a fresh session", () => {
      const result = resolveWithStoredEntry({
        entry: {
          sessionId: "existing-session-id-987",
          updatedAt: NOW_MS - 1000,
          status: "done",
          startedAt: NOW_MS - 10_000,
          endedAt: NOW_MS - 1_000,
          runtimeMs: 9_000,
          lastHeartbeatText: "old heartbeat",
          lastHeartbeatSentAt: NOW_MS - 1_000,
          heartbeatIsolatedBaseSessionKey: "agent:main:cron:old",
          model: "claude-opus-4-6",
          modelProvider: "anthropic",
          agentHarnessId: "claude-cli",
          agentRuntimeOverride: "claude-cli",
          cliSessionIds: { anthropic: "old-cli-session" },
          cliSessionBindings: {},
          claudeCliSessionId: "old-claude-session",
          liveModelSwitchPending: true,
          fallbackNoticeSelectedModel: "anthropic/claude-opus-4-6",
          fallbackNoticeActiveModel: "anthropic/claude-sonnet-4-6",
          fallbackNoticeReason: "rate limit",
          inputTokens: 1,
          outputTokens: 2,
          totalTokens: 3,
          totalTokensFresh: true,
          estimatedCostUsd: 0.01,
          execAsk: "always",
          execHost: "gateway",
          execNode: "node-1",
          execSecurity: "allowlist",
          cacheRead: 4,
          cacheWrite: 5,
          contextTokens: 200_000,
          compactionCount: 9,
          memoryFlushAt: NOW_MS - 500,
          abortCutoffMessageSid: "old-message",
          spawnedBy: "agent:main:session:parent",
          skillsSnapshot: {
            prompt: "old skills",
            skills: [{ name: "stale-skill" }],
          },
          systemPromptReport: {
            source: "run",
            generatedAt: NOW_MS,
            systemPrompt: {
              chars: 1,
              projectContextChars: 0,
              nonProjectContextChars: 1,
            },
            injectedWorkspaceFiles: [],
            skills: { promptChars: 0, entries: [] },
            tools: { listChars: 0, schemaChars: 0, entries: [] },
          },
          pluginDebugEntries: [{ pluginId: "test", lines: ["old"] }],
          elevatedLevel: "full",
          sendPolicy: "deny",
          groupActivation: "always",
          groupActivationNeedsSystemIntro: true,
          queueMode: "interrupt",
          queueDebounceMs: 500,
          queueCap: 25,
          queueDrop: "old",
          channel: "telegram" as never,
          groupId: "group-1",
          subject: "old subject",
          groupChannel: "ops",
          space: "team",
          origin: {
            provider: "telegram",
            to: "old-chat",
          },
          acp: {
            backend: "acpx",
            agent: "codex",
            runtimeSessionName: "old-acp",
            mode: "persistent",
            state: "idle",
            lastActivityAt: NOW_MS - 1_000,
          },
          authProfileOverride: "auto-auth",
          authProfileOverrideSource: "auto",
          authProfileOverrideCompactionCount: 2,
          modelOverride: "auto-model",
          providerOverride: "anthropic",
          modelOverrideSource: "auto",
        },
        fresh: true,
        forceNew: true,
      });

      expect(result.isNewSession).toBe(true);
      expect(result.sessionEntry.status).toBeUndefined();
      expect(result.sessionEntry.startedAt).toBeUndefined();
      expect(result.sessionEntry.endedAt).toBeUndefined();
      expect(result.sessionEntry.runtimeMs).toBeUndefined();
      expect(result.sessionEntry.lastHeartbeatText).toBeUndefined();
      expect(result.sessionEntry.lastHeartbeatSentAt).toBeUndefined();
      expect(result.sessionEntry.heartbeatIsolatedBaseSessionKey).toBeUndefined();
      expect(result.sessionEntry.model).toBeUndefined();
      expect(result.sessionEntry.modelProvider).toBeUndefined();
      expect(result.sessionEntry.agentHarnessId).toBeUndefined();
      expect(result.sessionEntry.agentRuntimeOverride).toBeUndefined();
      expect(result.sessionEntry.cliSessionIds).toBeUndefined();
      expect(result.sessionEntry.cliSessionBindings).toBeUndefined();
      expect(result.sessionEntry.claudeCliSessionId).toBeUndefined();
      expect(result.sessionEntry.liveModelSwitchPending).toBeUndefined();
      expect(result.sessionEntry.fallbackNoticeSelectedModel).toBeUndefined();
      expect(result.sessionEntry.fallbackNoticeActiveModel).toBeUndefined();
      expect(result.sessionEntry.fallbackNoticeReason).toBeUndefined();
      expect(result.sessionEntry.inputTokens).toBeUndefined();
      expect(result.sessionEntry.outputTokens).toBeUndefined();
      expect(result.sessionEntry.totalTokens).toBeUndefined();
      expect(result.sessionEntry.totalTokensFresh).toBeUndefined();
      expect(result.sessionEntry.estimatedCostUsd).toBeUndefined();
      expect(result.sessionEntry.execAsk).toBeUndefined();
      expect(result.sessionEntry.execHost).toBeUndefined();
      expect(result.sessionEntry.execNode).toBeUndefined();
      expect(result.sessionEntry.execSecurity).toBeUndefined();
      expect(result.sessionEntry.cacheRead).toBeUndefined();
      expect(result.sessionEntry.cacheWrite).toBeUndefined();
      expect(result.sessionEntry.contextTokens).toBeUndefined();
      expect(result.sessionEntry.compactionCount).toBeUndefined();
      expect(result.sessionEntry.memoryFlushAt).toBeUndefined();
      expect(result.sessionEntry.abortCutoffMessageSid).toBeUndefined();
      expect(result.sessionEntry.spawnedBy).toBeUndefined();
      expect(result.sessionEntry.skillsSnapshot).toBeUndefined();
      expect(result.sessionEntry.systemPromptReport).toBeUndefined();
      expect(result.sessionEntry.pluginDebugEntries).toBeUndefined();
      expect(result.sessionEntry.elevatedLevel).toBeUndefined();
      expect(result.sessionEntry.sendPolicy).toBeUndefined();
      expect(result.sessionEntry.groupActivation).toBeUndefined();
      expect(result.sessionEntry.groupActivationNeedsSystemIntro).toBeUndefined();
      expect(result.sessionEntry.queueMode).toBeUndefined();
      expect(result.sessionEntry.queueDebounceMs).toBeUndefined();
      expect(result.sessionEntry.queueCap).toBeUndefined();
      expect(result.sessionEntry.queueDrop).toBeUndefined();
      expect(result.sessionEntry.channel).toBeUndefined();
      expect(result.sessionEntry.groupId).toBeUndefined();
      expect(result.sessionEntry.subject).toBeUndefined();
      expect(result.sessionEntry.groupChannel).toBeUndefined();
      expect(result.sessionEntry.space).toBeUndefined();
      expect(result.sessionEntry.origin).toBeUndefined();
      expect(result.sessionEntry.acp).toBeUndefined();
      expect(result.sessionEntry.authProfileOverride).toBeUndefined();
      expect(result.sessionEntry.authProfileOverrideSource).toBeUndefined();
      expect(result.sessionEntry.authProfileOverrideCompactionCount).toBeUndefined();
      expect(result.sessionEntry.modelOverride).toBeUndefined();
      expect(result.sessionEntry.providerOverride).toBeUndefined();
      expect(result.sessionEntry.modelOverrideSource).toBeUndefined();
    });

    it("preserves user-selected model and auth overrides for fresh cron sessions", () => {
      const result = resolveWithStoredEntry({
        entry: {
          sessionId: "existing-session-id-654",
          updatedAt: NOW_MS - 1000,
          modelOverride: "claude-sonnet-4-6",
          providerOverride: "anthropic",
          modelOverrideSource: "user",
          authProfileOverride: "work-profile",
          authProfileOverrideSource: "user",
          authProfileOverrideCompactionCount: 3,
        },
        fresh: true,
        forceNew: true,
      });

      expect(result.isNewSession).toBe(true);
      expect(result.sessionEntry.modelOverride).toBe("claude-sonnet-4-6");
      expect(result.sessionEntry.providerOverride).toBe("anthropic");
      expect(result.sessionEntry.modelOverrideSource).toBe("user");
      expect(result.sessionEntry.authProfileOverride).toBe("work-profile");
      expect(result.sessionEntry.authProfileOverrideSource).toBe("user");
      expect(result.sessionEntry.authProfileOverrideCompactionCount).toBe(3);
    });

    it("preserves ambient session context for non-isolated expiration rollovers", () => {
      const result = resolveWithStoredEntry({
        entry: {
          sessionId: "existing-session-id-321",
          updatedAt: NOW_MS - 1000,
          elevatedLevel: "full",
          sendPolicy: "deny",
          queueMode: "collect",
          channel: "discord" as never,
          origin: { provider: "discord", to: "old-channel" },
        },
        fresh: false,
      });

      expect(result.isNewSession).toBe(true);
      expect(result.sessionEntry.elevatedLevel).toBe("full");
      expect(result.sessionEntry.sendPolicy).toBe("deny");
      expect(result.sessionEntry.queueMode).toBe("collect");
      expect(result.sessionEntry.channel).toBe("discord");
      expect(result.sessionEntry.origin).toEqual({ provider: "discord", to: "old-channel" });
    });

    it("clears delivery routing metadata when session is stale", () => {
      const result = resolveWithStoredEntry({
        entry: {
          sessionId: "old-session-id",
          updatedAt: NOW_MS - 86_400_000,
          lastChannel: "slack" as never,
          lastTo: "channel:C0XXXXXXXXX",
          lastThreadId: "1737500000.999999",
          deliveryContext: {
            channel: "slack",
            to: "channel:C0XXXXXXXXX",
            threadId: "1737500000.999999",
          },
        },
        fresh: false,
      });

      expect(result.isNewSession).toBe(true);
      expect(result.sessionEntry.lastChannel).toBeUndefined();
      expect(result.sessionEntry.lastTo).toBeUndefined();
      expect(result.sessionEntry.lastAccountId).toBeUndefined();
      expect(result.sessionEntry.lastThreadId).toBeUndefined();
      expect(result.sessionEntry.deliveryContext).toBeUndefined();
    });

    it("preserves delivery routing metadata when reusing fresh session", () => {
      const result = resolveWithStoredEntry({
        entry: {
          sessionId: "existing-session-id-101",
          updatedAt: NOW_MS - 1000,
          systemSent: true,
          lastChannel: "slack" as never,
          lastTo: "channel:C0XXXXXXXXX",
          lastThreadId: "1737500000.123456",
          deliveryContext: {
            channel: "slack",
            to: "channel:C0XXXXXXXXX",
            threadId: "1737500000.123456",
          },
        },
        fresh: true,
      });

      expect(result.isNewSession).toBe(false);
      expect(result.sessionEntry.lastChannel).toBe("slack");
      expect(result.sessionEntry.lastTo).toBe("channel:C0XXXXXXXXX");
      expect(result.sessionEntry.lastThreadId).toBe("1737500000.123456");
      expect(result.sessionEntry.deliveryContext).toEqual({
        channel: "slack",
        to: "channel:C0XXXXXXXXX",
        threadId: "1737500000.123456",
      });
    });

    it("creates new sessionId when entry exists but has no sessionId", () => {
      const result = resolveWithStoredEntry({
        entry: {
          updatedAt: NOW_MS - 1000,
          modelOverride: "some-model",
        },
      });

      expect(result.sessionEntry.sessionId).toBeDefined();
      expect(result.isNewSession).toBe(true);
      // Should still preserve other fields from entry
      expect(result.sessionEntry.modelOverride).toBe("some-model");
    });
  });

  // Tests for stale model-selection override clearing (#57947, #47592)
  describe("payloadModel override clearing", () => {
    it("clears model-selection overrides when forceNew and payloadModel are both set", () => {
      const result = resolveWithStoredEntry({
        entry: {
          sessionId: "old-session-id",
          updatedAt: NOW_MS - 86_400_000,
          modelOverride: "claude-opus-4.5",
          providerOverride: "github-copilot",
          authProfileOverride: "github-copilot:github",
          authProfileOverrideSource: "auto",
          authProfileOverrideCompactionCount: 3,
          fallbackNoticeActiveModel: "bailian/glm-5",
          fallbackNoticeSelectedModel: "github-copilot/claude-opus-4.6",
          fallbackNoticeReason: "rate limit",
          sendPolicy: "allow",
        },
        forceNew: true,
        payloadModel: "bailian/qwen3.5-plus",
        isCronOwnedSession: true,
      });

      expect(result.isNewSession).toBe(true);
      // Model-selection overrides must be cleared
      expect(result.sessionEntry.providerOverride).toBeUndefined();
      expect(result.sessionEntry.modelOverride).toBeUndefined();
      expect(result.sessionEntry.fallbackNoticeActiveModel).toBeUndefined();
      expect(result.sessionEntry.fallbackNoticeSelectedModel).toBeUndefined();
      expect(result.sessionEntry.fallbackNoticeReason).toBeUndefined();
      // Auth profile overrides must be PRESERVED to maintain round-robin
      // rotation across runs — resolveSessionAuthProfileOverride() uses the
      // previous value to pickNextAvailable() instead of pickFirstAvailable()
      expect(result.sessionEntry.authProfileOverride).toBe("github-copilot:github");
      expect(result.sessionEntry.authProfileOverrideSource).toBe("auto");
      expect(result.sessionEntry.authProfileOverrideCompactionCount).toBe(3);
      // Non-override fields must be preserved
      expect(result.sessionEntry.sendPolicy).toBe("allow");
    });

    it("preserves model-selection overrides on shared sessions even with payloadModel", () => {
      // Shared session target (no forceNew): the session entry persists back
      // to the interactive session store.  Clearing overrides here would
      // destroy user-set model preferences on the next interactive use.
      const result = resolveWithStoredEntry({
        entry: {
          sessionId: "old-session-id",
          updatedAt: NOW_MS - 86_400_000,
          modelOverride: "claude-opus-4.5",
          providerOverride: "github-copilot",
          fallbackNoticeActiveModel: "bailian/glm-5",
          fallbackNoticeSelectedModel: "github-copilot/claude-opus-4.6",
          fallbackNoticeReason: "rate limit",
        },
        fresh: false,
        payloadModel: "bailian/qwen3.5-plus",
      });

      expect(result.isNewSession).toBe(true);
      // Overrides must be preserved — shared session, not forceNew
      expect(result.sessionEntry.modelOverride).toBe("claude-opus-4.5");
      expect(result.sessionEntry.providerOverride).toBe("github-copilot");
      expect(result.sessionEntry.fallbackNoticeActiveModel).toBe("bailian/glm-5");
      expect(result.sessionEntry.fallbackNoticeSelectedModel).toBe(
        "github-copilot/claude-opus-4.6",
      );
      expect(result.sessionEntry.fallbackNoticeReason).toBe("rate limit");
    });

    it("preserves model-selection overrides when payloadModel is not set", () => {
      const result = resolveWithStoredEntry({
        entry: {
          sessionId: "old-session-id",
          updatedAt: NOW_MS - 86_400_000,
          modelOverride: "gpt-4.1-mini",
          providerOverride: "openai",
          authProfileOverride: "openai:default",
          authProfileOverrideSource: "user",
          authProfileOverrideCompactionCount: 1,
        },
        forceNew: true,
      });

      expect(result.isNewSession).toBe(true);
      // Without payloadModel, overrides must be preserved (backward compatibility)
      expect(result.sessionEntry.modelOverride).toBe("gpt-4.1-mini");
      expect(result.sessionEntry.providerOverride).toBe("openai");
      expect(result.sessionEntry.authProfileOverride).toBe("openai:default");
      expect(result.sessionEntry.authProfileOverrideSource).toBe("user");
      expect(result.sessionEntry.authProfileOverrideCompactionCount).toBe(1);
    });

    it("preserves model-selection overrides when payloadModel is empty string", () => {
      const result = resolveWithStoredEntry({
        entry: {
          sessionId: "old-session-id",
          updatedAt: NOW_MS - 86_400_000,
          modelOverride: "gpt-4.1-mini",
          providerOverride: "openai",
        },
        forceNew: true,
        payloadModel: "",
      });

      expect(result.isNewSession).toBe(true);
      // Empty string is falsy — overrides must be preserved
      expect(result.sessionEntry.modelOverride).toBe("gpt-4.1-mini");
      expect(result.sessionEntry.providerOverride).toBe("openai");
    });

    it("does not clear model-selection overrides on fresh session reuse even with payloadModel", () => {
      const result = resolveWithStoredEntry({
        entry: {
          sessionId: "existing-session-id",
          updatedAt: NOW_MS - 1000,
          modelOverride: "claude-opus-4.5",
          providerOverride: "github-copilot",
        },
        fresh: true,
        payloadModel: "bailian/qwen3.5-plus",
      });

      expect(result.isNewSession).toBe(false);
      // Session is reused (not new), so overrides must NOT be cleared
      expect(result.sessionEntry.modelOverride).toBe("claude-opus-4.5");
      expect(result.sessionEntry.providerOverride).toBe("github-copilot");
    });

    it("clears model-selection overrides and delivery routing when forceNew and payloadModel set", () => {
      const result = resolveWithStoredEntry({
        entry: {
          sessionId: "existing-session-id",
          updatedAt: NOW_MS - 1000,
          systemSent: true,
          modelOverride: "sonnet-4",
          providerOverride: "anthropic",
          lastChannel: "slack" as never,
          lastTo: "channel:C0XXXXXXXXX",
        },
        fresh: true,
        forceNew: true,
        payloadModel: "bailian/glm-5",
        isCronOwnedSession: true,
      });

      expect(result.isNewSession).toBe(true);
      // Model-selection overrides cleared
      expect(result.sessionEntry.providerOverride).toBeUndefined();
      expect(result.sessionEntry.modelOverride).toBeUndefined();
      // Delivery routing also cleared (existing behavior)
      expect(result.sessionEntry.lastChannel).toBeUndefined();
      expect(result.sessionEntry.lastTo).toBeUndefined();
    });

    it("preserves model-selection overrides on hook-dispatched isolated sessions (deliveryContract shared)", () => {
      // Hook-dispatched jobs set forceNew (sessionTarget "isolated") and
      // deliveryContract "shared".  Even when payload.model is set, the
      // isCronOwnedSession guard (derived from deliveryContract) prevents
      // clearing overrides on what is effectively a shared session.
      const result = resolveWithStoredEntry({
        entry: {
          sessionId: "interactive-session-id",
          updatedAt: NOW_MS - 1000,
          modelOverride: "claude-opus-4.6",
          providerOverride: "github-copilot",
          fallbackNoticeActiveModel: "bailian/glm-5",
          fallbackNoticeSelectedModel: "github-copilot/claude-opus-4.6",
          fallbackNoticeReason: "rate limit",
        },
        forceNew: true,
        payloadModel: "bailian/qwen3.5-plus",
        isCronOwnedSession: false,
      });

      expect(result.isNewSession).toBe(true);
      // Overrides must be preserved — deliveryContract is "shared", not cron-owned
      expect(result.sessionEntry.modelOverride).toBe("claude-opus-4.6");
      expect(result.sessionEntry.providerOverride).toBe("github-copilot");
      expect(result.sessionEntry.fallbackNoticeActiveModel).toBe("bailian/glm-5");
      expect(result.sessionEntry.fallbackNoticeSelectedModel).toBe(
        "github-copilot/claude-opus-4.6",
      );
      expect(result.sessionEntry.fallbackNoticeReason).toBe("rate limit");
    });
  });
});
