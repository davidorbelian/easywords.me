// Stands in for the Jev and Anthropic APIs so tests never use real tokens.
// Text containing a marker word changes the reply: FAIL_CLAUDE, FAIL_JEV, SLOW_CLAUDE.
import { createServer } from "node:http";

const port = Number(process.env.FAKE_UPSTREAM_PORT ?? 8787);
export const REWRITE = ["The cat ", "sat on ", "the mat."];

function readBody(request) {
  return new Promise((resolve) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => resolve(body));
  });
}

function jevScore(text) {
  const words = text.split(/\s+/).filter(Boolean);
  const average = words.reduce((sum, word) => sum + word.length, 0) / Math.max(1, words.length);
  return Math.min(5, Math.max(0, 9 - average));
}

function sse(response, event) {
  response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function messages(body, response) {
  const prompt = JSON.stringify(body.messages);
  if (prompt.includes("FAIL_CLAUDE")) {
    response.writeHead(400, { "content-type": "application/json" });
    response.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "fake failure" } }));
    return;
  }
  const delay = prompt.includes("SLOW_CLAUDE") ? 1500 : 30;
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  sse(response, {
    type: "message_start",
    message: {
      id: "msg_fake",
      type: "message",
      role: "assistant",
      model: body.model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 1 },
    },
  });
  sse(response, { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
  for (const text of REWRITE) {
    await sleep(delay);
    sse(response, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });
  }
  sse(response, { type: "content_block_stop", index: 0 });
  sse(response, {
    type: "message_delta",
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: { output_tokens: 8 },
  });
  sse(response, { type: "message_stop" });
  response.end();
}

createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://localhost");
  const raw = await readBody(request);
  const body = raw ? JSON.parse(raw) : {};
  if (process.env.FAKE_UPSTREAM_LOG) console.log(request.method, url.pathname, raw.slice(0, 200));

  if (url.pathname === "/health") {
    response.end("ok");
  } else if (url.pathname === "/v1/systemone") {
    if (String(body.state).includes("FAIL_JEV")) {
      response.writeHead(500).end();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ answers: { simplicity: { type: "score", score: jevScore(String(body.state)) } } }));
  } else if (url.pathname === "/v1/messages" && request.method === "POST") {
    await messages(body, response);
  } else {
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: "not here" } }));
  }
}).listen(port, "127.0.0.1", () => console.log(`fake upstream on :${port}`));
