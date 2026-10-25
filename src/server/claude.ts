import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Example } from "../shared/rules.ts";

export type Rewriter = (text: string, systemPrompt: string, signal: AbortSignal) => AsyncIterable<string>;

const MODEL = "claude-sonnet-5-5";

/** The shared rules, the personality's prompt, then the rewrites it got right. */
export function systemPrompt(rules: string, personalityPrompt: string, examples: Example[] = []): string {
  return [rules.trim(), personalityPrompt.trim(), examplesPrompt(examples)].filter(Boolean).join("\n\n");
}

function examplesPrompt(examples: Example[]): string {
  if (examples.length === 0) return "";
  return [
    "Rewrites this personality got right. Copy their voice, length and structure.",
    "They are about other texts, so never take facts from them.",
    ...examples.map(
      ({ text, rewrite }) =>
        `<example>\n<original>\n${text.trim()}\n</original>\n<rewrite>\n${rewrite.trim()}\n</rewrite>\n</example>`,
    ),
  ].join("\n");
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
