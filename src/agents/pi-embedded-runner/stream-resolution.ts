import type { StreamFn } from "@mariozechner/pi-agent-core";
import { getApiProvider, streamSimple } from "@mariozechner/pi-ai";
import { createAnthropicVertexStreamFnForModel } from "../anthropic-vertex-stream.js";
import { createBoundaryAwareStreamFnForModel } from "../provider-transport-stream.js";
import { stripSystemPromptCacheBoundary } from "../system-prompt-cache-boundary.js";
import type { EmbeddedRunAttemptParams } from "./run/types.js";

let embeddedAgentBaseStreamFnCache = new WeakMap<object, StreamFn | undefined>();
let piNativeCodexResponsesStreamFnForTest: StreamFn | undefined;

export function resolveEmbeddedAgentBaseStreamFn(params: {
  session: { agent: { streamFn?: StreamFn } };
}): StreamFn | undefined {
  const cached = embeddedAgentBaseStreamFnCache.get(params.session);
  if (cached !== undefined || embeddedAgentBaseStreamFnCache.has(params.session)) {
    return cached;
  }
  const baseStreamFn = params.session.agent.streamFn;
  embeddedAgentBaseStreamFnCache.set(params.session, baseStreamFn);
  return baseStreamFn;
}

export function resetEmbeddedAgentBaseStreamFnCacheForTest(): void {
  embeddedAgentBaseStreamFnCache = new WeakMap<object, StreamFn | undefined>();
}

function isDefaultPiStreamFnForModel(
  model: EmbeddedRunAttemptParams["model"],
  streamFn: StreamFn | undefined,
): boolean {
  if (!streamFn || streamFn === streamSimple) {
    return true;
  }
  const api = typeof model.api === "string" ? model.api.trim() : "";
  if (!api) {
    return false;
  }
  const provider = getApiProvider(api as never);
  return streamFn === provider?.streamSimple || streamFn === provider?.stream;
}

function hasResolvedRuntimeApiKey(apiKey: string | undefined): boolean {
  return typeof apiKey === "string" && apiKey.trim().length > 0;
}

function isOpenAICodexResponsesModel(model: EmbeddedRunAttemptParams["model"]): boolean {
  return model.provider === "openai-codex" && model.api === "openai-codex-responses";
}

function resolvePiNativeCodexResponsesStreamFn(params: {
  model: EmbeddedRunAttemptParams["model"];
  currentStreamFn: StreamFn | undefined;
}): StreamFn | undefined {
  if (!isOpenAICodexResponsesModel(params.model)) {
    return undefined;
  }
  if (!isDefaultPiStreamFnForModel(params.model, params.currentStreamFn)) {
    return undefined;
  }
  return piNativeCodexResponsesStreamFnForTest ?? params.currentStreamFn ?? streamSimple;
}

export function describeEmbeddedAgentStreamStrategy(params: {
  currentStreamFn: StreamFn | undefined;
  providerStreamFn?: StreamFn;
  model: EmbeddedRunAttemptParams["model"];
  resolvedApiKey?: string;
}): string {
  if (params.providerStreamFn) {
    return "provider";
  }
  if (params.model.provider === "anthropic-vertex") {
    return "anthropic-vertex";
  }
  if (
    resolvePiNativeCodexResponsesStreamFn({
      model: params.model,
      currentStreamFn: params.currentStreamFn,
    })
  ) {
    return "pi-native-codex-responses";
  }
  if (isDefaultPiStreamFnForModel(params.model, params.currentStreamFn)) {
    return createBoundaryAwareStreamFnForModel(params.model)
      ? `boundary-aware:${params.model.api}`
      : "stream-simple";
  }
  if (
    hasResolvedRuntimeApiKey(params.resolvedApiKey) &&
    createBoundaryAwareStreamFnForModel(params.model)
  ) {
    return `boundary-aware:${params.model.api}`;
  }
  return "session-custom";
}

export async function resolveEmbeddedAgentApiKey(params: {
  provider: string;
  resolvedApiKey?: string;
  authStorage?: { getApiKey(provider: string): Promise<string | undefined> };
}): Promise<string | undefined> {
  const resolvedApiKey = params.resolvedApiKey?.trim();
  if (resolvedApiKey) {
    return resolvedApiKey;
  }
  return params.authStorage ? await params.authStorage.getApiKey(params.provider) : undefined;
}

export function resolveEmbeddedAgentStreamFn(params: {
  currentStreamFn: StreamFn | undefined;
  providerStreamFn?: StreamFn;
  sessionId: string;
  signal?: AbortSignal;
  model: EmbeddedRunAttemptParams["model"];
  resolvedApiKey?: string;
  authStorage?: { getApiKey(provider: string): Promise<string | undefined> };
}): StreamFn {
  if (params.providerStreamFn) {
    return wrapEmbeddedAgentStreamFn(params.providerStreamFn, {
      runSignal: params.signal,
      resolvedApiKey: params.resolvedApiKey,
      authStorage: params.authStorage,
      providerId: params.model.provider,
      transformContext: (context) =>
        context.systemPrompt
          ? {
              ...context,
              systemPrompt: stripSystemPromptCacheBoundary(context.systemPrompt),
            }
          : context,
    });
  }

  const currentStreamFn = params.currentStreamFn ?? streamSimple;
  if (params.model.provider === "anthropic-vertex") {
    return createAnthropicVertexStreamFnForModel(params.model);
  }

  const piNativeCodexResponsesStreamFn = resolvePiNativeCodexResponsesStreamFn({
    model: params.model,
    currentStreamFn: params.currentStreamFn,
  });
  if (piNativeCodexResponsesStreamFn) {
    return wrapEmbeddedAgentStreamFn(piNativeCodexResponsesStreamFn, {
      runSignal: params.signal,
      resolvedApiKey: params.resolvedApiKey,
      authStorage: params.authStorage,
      providerId: params.model.provider,
      sessionId: params.sessionId,
      transformContext: (context) =>
        context.systemPrompt
          ? {
              ...context,
              systemPrompt: stripSystemPromptCacheBoundary(context.systemPrompt),
            }
          : context,
    });
  }

  if (
    isDefaultPiStreamFnForModel(params.model, params.currentStreamFn) ||
    hasResolvedRuntimeApiKey(params.resolvedApiKey)
  ) {
    const boundaryAwareStreamFn = createBoundaryAwareStreamFnForModel(params.model);
    if (boundaryAwareStreamFn) {
      // Some PI session factories return a provider-specific stream wrapper
      // once runtime auth is resolved. Keep transport-supported APIs on
      // OpenClaw's HTTP transport so provider-specific auth/header semantics
      // are not lost behind that wrapper.
      // Boundary-aware transports read credentials from options.apiKey just
      // like provider-owned streams, but the embedded run layer never gets to
      // inject the resolved runtime key for them. Without this wrap, OAuth
      // providers (e.g. openai-codex/gpt-5.5) hit the Responses API with an
      // empty bearer and fail with 401 Missing bearer auth header.
      // Also strip empty tools/tool_choice — strict providers (DashScope/GLM,
      // Kimi, vLLM) reject tools: [] with HTTP 400. Fixes #53174, #59898, #47947.
      return wrapStreamFnStripEmptyTools(
        wrapEmbeddedAgentStreamFn(boundaryAwareStreamFn, {
          runSignal: params.signal,
          resolvedApiKey: params.resolvedApiKey,
          authStorage: params.authStorage,
          providerId: params.model.provider,
        }),
      );
    }
  }

  // Wrap with empty-tools guard for any custom stream function as well.
  return wrapStreamFnStripEmptyTools(currentStreamFn);
}

/**
 * Wraps a stream function to strip empty `tools` arrays from outgoing payloads.
 * Strict OpenAI-compatible providers (DashScope/GLM, Kimi, vLLM) reject
 * `tools: []` with HTTP 400. Omitting the field entirely is the correct
 * behavior for tool-less requests.
 */
function wrapStreamFnStripEmptyTools(base: StreamFn): StreamFn {
  return (model, context, options) => {
    return base(model, context, {
      ...options,
      onPayload: (payload, model) => {
        if (payload && typeof payload === "object") {
          const p = payload as Record<string, unknown>;
          if (Array.isArray(p.tools) && p.tools.length === 0) {
            delete p.tools;
          }
          // Also strip tool_choice when tools are absent — some providers
          // reject tool_choice without a corresponding tools array.
          // Fixes #47947.
          if (p.tool_choice !== undefined && p.tools === undefined) {
            delete p.tool_choice;
          }
        }
        return options?.onPayload?.(payload, model);
      },
    });
  };
}

export const __testing = {
  setPiNativeCodexResponsesStreamFnForTest(streamFn: StreamFn | undefined): void {
    piNativeCodexResponsesStreamFnForTest = streamFn;
  },
  resetPiNativeCodexResponsesStreamFnForTest(): void {
    piNativeCodexResponsesStreamFnForTest = undefined;
  },
};

function wrapEmbeddedAgentStreamFn(
  inner: StreamFn,
  params: {
    runSignal: AbortSignal | undefined;
    resolvedApiKey: string | undefined;
    authStorage: { getApiKey(provider: string): Promise<string | undefined> } | undefined;
    providerId: string;
    sessionId?: string;
    transformContext?: (context: Parameters<StreamFn>[1]) => Parameters<StreamFn>[1];
  },
): StreamFn {
  const transformContext =
    params.transformContext ?? ((context: Parameters<StreamFn>[1]) => context);
  const mergeRunSignal = (options: Parameters<StreamFn>[2]) => {
    const signal = options?.signal ?? params.runSignal;
    const merged =
      params.sessionId && !options?.sessionId
        ? { ...options, sessionId: params.sessionId }
        : options;
    return signal ? { ...merged, signal } : merged;
  };
  if (!params.authStorage && !params.resolvedApiKey) {
    return (m, context, options) => inner(m, transformContext(context), mergeRunSignal(options));
  }
  const { authStorage, providerId, resolvedApiKey } = params;
  return async (m, context, options) => {
    const apiKey = await resolveEmbeddedAgentApiKey({
      provider: providerId,
      resolvedApiKey,
      authStorage,
    });
    return inner(m, transformContext(context), {
      ...mergeRunSignal(options),
      apiKey: apiKey ?? options?.apiKey,
    });
  };
}
