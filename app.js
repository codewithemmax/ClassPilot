/**
 * ClassPilot Bolt Agent (JavaScript / ESM) — Groq version
 *
 * Handles messages in Slack, reasons via Groq (Llama 3.3 70B) about which MCP
 * tool to call, and replies using Block Kit with a "mark resolved" feedback row.
 *
 * Requires:
 *   npm install @slack/bolt groq-sdk @modelcontextprotocol/sdk dotenv
 *
 * .env:
 *   SLACK_BOT_TOKEN=xoxb-...
 *   SLACK_APP_TOKEN=xapp-...
 *   GROQ_API_KEY=gsk_...
 *
 * Note: package.json must have "type": "module".
 * Run:  node app.js   (it auto-spawns mcpServer.js as a subprocess)
 */

import "dotenv/config";
import http from "http";
import pkg from "@slack/bolt";
const { App, LogLevel } = pkg;
import Groq from "groq-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
  logLevel: LogLevel.INFO,
});

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const MODEL = "llama-3.3-70b-versatile";

// OpenAI-format tool schema (Groq is OpenAI-compatible).
const TOOLS = [
  {
    type: "function",
    function: {
      name: "search_questions",
      description: "Search the question bank for entries matching a topic or keyword.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          course_code: { type: "string" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_formula",
      description: "Retrieve the formula reference for a given topic.",
      parameters: {
        type: "object",
        properties: {
          topic: { type: "string" },
          course_code: { type: "string" },
        },
        required: ["topic"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "log_topic_gap",
      description: "Log whether a student's question on a topic/subtopic was resolved.",
      parameters: {
        type: "object",
        properties: {
          topic: { type: "string" },
          subtopic: { type: "string" },
          resolved: { type: "boolean" },
          course_code: { type: "string" },
        },
        required: ["topic", "subtopic", "resolved"],
      },
    },
  },
];

// ---- MCP client (spawns mcpServer.js as a subprocess) ----
let mcpClient = null;

async function getMcpClient() {
  if (mcpClient) return mcpClient;

  const transport = new StdioClientTransport({
    command: "node",
    args: ["mcpServer.js"],
    env: process.env, // must be explicit — subprocess doesn't auto-inherit on all platforms
  });

  const client = new Client({ name: "classpilot-agent", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
  mcpClient = client;
  return client;
}

async function callMcpTool(name, args) {
  const client = await getMcpClient();
  return client.callTool({ name, arguments: args });
}

function extractJson(toolResult) {
  try {
    const text = toolResult?.content?.[0]?.text;
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

// Slack's section block has a hard 3000-character limit on `text`. Split
// long answers into multiple section blocks instead of truncating.
function chunkText(text, maxLen = 2900) {
  const chunks = [];
  let remaining = text;
  while (remaining.length > maxLen) {
    let splitAt = remaining.lastIndexOf("\n", maxLen);
    if (splitAt < maxLen * 0.5) splitAt = maxLen;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

function buildAnswerBlocks(answerText, topic, subtopic) {
  const textChunks = chunkText(answerText);

  const answerBlocks = textChunks.map((chunk) => ({
    type: "section",
    text: { type: "mrkdwn", text: chunk },
  }));

  return [
    ...answerBlocks,
    {
      type: "context",
      elements: [{ type: "mrkdwn", text: `Topic: *${topic}* · Subtopic: *${subtopic}*` }],
    },
    {
      type: "actions",
      block_id: `gap_feedback|${topic}|${subtopic}`,
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "✅ This answered it" },
          action_id: "mark_resolved",
          style: "primary",
        },
        {
          type: "button",
          text: { type: "plain_text", text: "❌ Still stuck" },
          action_id: "mark_unresolved",
          style: "danger",
        },
      ],
    },
  ];
}

const SYSTEM_PROMPT = `You are ClassPilot, a study assistant for engineering students, running inside Slack.

CRITICAL — Slack formatting rules:
Slack uses "mrkdwn", NOT standard Markdown and NOT LaTeX. Follow these exactly:
- Never use $$...$$ or $...$ for math. Write formulas as plain text, e.g. *W = m·R·T·ln(p2/p1)*, or inside a code block using triple backticks.
- Never use ### or ## headers. For a section label, put it on its own line in *bold*.
- Use *single asterisks* for bold, NOT **double**.
- Use "-" or "•" for bullets, never numbered Markdown headers.
- Keep every formula as plain text or inside a code block, never LaTeX.

CRITICAL — Always use your tools:
For every student question you MUST call search_questions first, even if you already know the answer, so the question gets logged for topic-gap tracking (the core purpose for lecturers and class reps). Only skip it if the message is clearly not academic (e.g. a greeting).
If search_questions returns no strong match, you may also call get_formula or answer from your own knowledge — but always identify a topic and subtopic based on the question's subject, even if the tools returned nothing, so gap tracking has something meaningful to log.

Keep answers concise and student-friendly.`;

/**
 * Runs a manual tool-calling loop with Groq (OpenAI-style tool_calls).
 */
async function runAgent(userText) {
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: userText },
  ];

  let topic = "General";
  let subtopic = "Unspecified";

  for (let step = 0; step < 5; step++) {
    const response = await groq.chat.completions.create({
      model: MODEL,
      messages,
      tools: TOOLS,
    });

    const message = response.choices[0].message;
    const toolCalls = message.tool_calls ?? [];

    if (toolCalls.length === 0) {
      return { text: message.content ?? "", topic, subtopic };
    }

    // Record the assistant's tool-call turn.
    messages.push(message);

    // Execute each requested tool via MCP and append tool results.
    for (const toolCall of toolCalls) {
      const fnName = toolCall.function.name;
      const args = JSON.parse(toolCall.function.arguments || "{}");
      const result = await callMcpTool(fnName, args);
      const parsed = extractJson(result);

      if (fnName === "search_questions" || fnName === "get_formula") {
        if (Array.isArray(parsed) && parsed.length > 0) {
          topic = parsed[0].topic ?? topic;
          subtopic = parsed[0].subtopic ?? subtopic;
        }
      }

      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        name: fnName,
        content: JSON.stringify(parsed ?? result),
      });
    }
  }

  return { text: "Sorry, I couldn't complete that in time. Try rephrasing?", topic, subtopic };
}

app.message(async ({ message, say }) => {
  if (message.subtype || message.bot_id) return;

  const userText = message.text ?? "";
  if (!userText.trim()) return;

  try {
    const { text, topic, subtopic } = await runAgent(userText);

    if (!text || !text.trim()) {
      await say(
        "I couldn't find anything on that in our question bank, and I'm not confident enough to answer from general knowledge. Try rephrasing, or ask your lecturer/class rep directly — I've logged this so it shows up in the topic-gap summary."
      );
      await callMcpTool("log_topic_gap", {
        topic: topic || "Unmatched",
        subtopic: subtopic || "Unmatched",
        resolved: false,
      }).catch(() => {});
      return;
    }

    await say({ blocks: buildAnswerBlocks(text, topic, subtopic), text });
  } catch (err) {
    console.error("Error handling message:", err);
    await say(
      "Sorry, something went wrong on my end processing that question (server error). Give it another try in a moment — if it keeps happening, let whoever manages this workspace know."
    );
  }
});

app.action("mark_resolved", async ({ ack, body }) => {
  await ack();
  const blockId = body.actions[0].block_id;
  const [, topic, subtopic] = blockId.split("|");
  await callMcpTool("log_topic_gap", { topic, subtopic, resolved: true });
});

app.action("mark_unresolved", async ({ ack, body }) => {
  await ack();
  const blockId = body.actions[0].block_id;
  const [, topic, subtopic] = blockId.split("|");
  await callMcpTool("log_topic_gap", { topic, subtopic, resolved: false });
});

app.command("/study-gaps", async ({ ack, respond }) => {
  await ack();
  try {
    const result = await callMcpTool("get_topic_gap_summary", {});
    const gaps = extractJson(result);

    if (!gaps || gaps.length === 0) {
      await respond("No unresolved topic gaps logged yet.");
      return;
    }

    const lines = ["*Top unresolved topics:*"];
    for (const g of gaps) {
      lines.push(`• ${g.topic_subtopic} — ${g.unresolved_count} unresolved`);
    }

    await respond(lines.join("\n"));
  } catch (err) {
    console.error("Error fetching topic gap summary:", err);
    await respond("Sorry, I hit a server error pulling the topic-gap summary. Try again in a moment.");
  }
});

// Minimal HTTP server so uptime pingers can keep a free-tier host awake.
const PORT = process.env.PORT || 3000;
http
  .createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ClassPilot is alive");
  })
  .listen(PORT, () => {
    console.log(`Health endpoint listening on port ${PORT}`);
  });

(async () => {
  await app.start();
  console.log("⚡️ ClassPilot is running (Groq)!");
})();