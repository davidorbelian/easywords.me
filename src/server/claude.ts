import { query } from "@anthropic-ai/claude-agent-sdk";

export type Rewriter = (text: string, systemPrompt: string, signal: AbortSignal) => AsyncIterable<string>;

const MODEL = "claude-sonnet-5-5";

export function systemPrompt(rules: string, stylePrompt: string): string {
  return [rules.trim(), stylePrompt.trim()].filter(Boolean).join("\n\n");
}

export function createClaudeRewriter(oauthToken: string, baseUrl: string | undefined): Rewriter {
  return async function* (text, system, signal) {
    const abortController = new AbortController();
    const abort = () => abortController.abort();
    signal.addEventListener("abort", abort, { once: true });
    try {
      const messages = query({
        prompt: `<text>\n${text}\n</text>`,
        options: {
          model: MODEL,
          systemPrompt: system,
          tools: [],
          settingSources: [],
          persistSession: false,
          includePartialMessages: true,
          verbatimPrompts: true,
          maxTurns: 1,
          thinking: { type: "disabled" },
          abortController,
          // Replaces the inherited environment, so the CLI only sees what it needs.
          env: {
            PATH: process.env.PATH,
            HOME: process.env.HOME,
            CLAUDE_CODE_OAUTH_TOKEN: oauthToken,
            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
            CLAUDE_AGENT_SDK_CLIENT_APP: "easywords",
            ANTHROPIC_BASE_URL: baseUrl,
          },
        },
      });
      for await (const message of messages) {
        if (
          message.type === "stream_event" &&
          message.parent_tool_use_id === null &&
          message.event.type === "content_block_delta" &&
          message.event.delta.type === "text_delta"
        ) {
          yield message.event.delta.text;
        } else if (message.type === "result" && (message.subtype !== "success" || message.is_error)) {
          throw new Error(`Claude failed: ${message.subtype}`);
        }
      }
    } finally {
      signal.removeEventListener("abort", abort);
    }
  };
}
