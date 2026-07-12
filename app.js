/**
 * ClassPilot Bolt Agent (JavaScript / ESM) — Gemini version
 *
 * Handles messages in Slack, reasons via Gemini about which MCP tool to call,
 * and replies using Block Kit with a "mark resolved" feedback row.
 *
 * Requires:
 *   npm install @slack/bolt @google/genai @modelcontextprotocol/sdk dotenv
 *
 * .env:
 *   SLACK_BOT_TOKEN=xoxb-...
 *   SLACK_APP_TOKEN=xapp-...
 *   GEMINI_API_KEY=your-google-ai-studio-key
 *
 * Note: package.json must have "type": "module".
 * Run:  node app.js   (it auto-spawns mcpServer.js as a subprocess)
 */

import "dotenv/config";
import pkg from "@slack/bolt";
const { App, LogLevel } = pkg;
import { GoogleGenAI } from "@google/genai";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
  logLevel: LogLevel.INFO,
});

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const MODEL = "gemini-flash-latest";

// Gemini function declarations (equivalent to Anthropic's tools schema).
const FUNCTION_DECLARATIONS = [
  {
    name: "search_questions",
    description: "Search the question bank for entries matching a topic or keyword.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        course_code: { type: "string" },
      },
      required: ["query"],
    },
  },
  {
    name: "get_formula",
    description: "Retrieve the formula reference for a given topic.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        topic: { type: "string" },
        course_code: { type: "string" },
      },
      required: ["topic"],
    },
  },
  {
    name: "log_topic_gap",
    description: "Log whether a student's question on a topic/subtopic was resolved.",
    parametersJsonSchema: {
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
];

// ---- MCP client (spawns mcpServer.js as a subprocess) ----
let mcpClient = null;

async function getMcpClient() {
  if (mcpClient) return mcpClient;

  const transport = new StdioClientTransport({
    command: "node",
    args: ["mcpServer.js"],
    env: process.env, // must be explicit — the subprocess does not
                       // automatically inherit parent env vars on all platforms,
                       // which is why this worked locally but failed on Render.
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

// Slack's section block has a hard 3000-character limit on `text`. Long
// Gemini answers can exceed this, which causes an `invalid_blocks` API error
// and silently drops the whole message. Split into multiple section blocks
// instead of truncating, so long formula explanations still come through.
function chunkText(text, maxLen = 2900) {
  const chunks = [];
  let remaining = text;
  while (remaining.length > maxLen) {
    // Prefer to split on a paragraph or line break near the limit, not mid-word.
    let splitAt = remaining.lastIndexOf("\n", maxLen);
    if (splitAt < maxLen * 0.5) splitAt = maxLen; // fallback: hard split
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
Slack messages use "mrkdwn", NOT standard Markdown and NOT LaTeX. Follow these rules exactly:
- Never use $$...$$ or $...$ for math. Write formulas as plain text, e.g. *W = m·R·T·ln(p2/p1)*, or put them inside a code block using triple backticks.
- Never use ### or ## headers. If you need a section label, put it on its own line in *bold*.
- Use *single asterisks* for bold (NOT **double asterisks**).
- Use "-" or "•" for bullet points, never numbered Markdown headers.
- Keep every formula readable as plain text or inside a code block, never as LaTeX.

CRITICAL — Always use your tools:
For every student question you MUST call search_questions first, even if you already know the answer, so the question is logged for topic-gap tracking (the core purpose of this tool for lecturers and class reps). Only skip it if the message is clearly not academic (e.g. a greeting).
If search_questions returns no strong match you may also call get_formula or answer from your own knowledge — but always identify a topic and subtopic based on the question's subject, even if the tools returned nothing, so gap tracking has something meaningful to log.

Keep answers concise and student-friendly.`;

/**
 * Runs a manual tool-calling loop with Gemini.
 * We drive the loop ourselves (rather than automatic function calling) so we can
 * capture topic/subtopic from tool results for gap tracking.
 */
async function runAgent(userText) {
  // Gemini conversation history: array of {role, parts}
  const contents = [{ role: "user", parts: [{ text: userText }] }];

  let topic = "General";
  let subtopic = "Unspecified";

  // Loop until the model stops requesting function calls (cap iterations for safety)
  for (let step = 0; step < 5; step++) {
    const response = await ai.models.generateContent({
      model: MODEL,
      contents,
      config: {
        systemInstruction: SYSTEM_PROMPT,
        tools: [{ functionDeclarations: FUNCTION_DECLARATIONS }],
      },
    });

    const functionCalls = response.functionCalls ?? [];

    if (functionCalls.length === 0) {
      // No more tool calls — return final text.
      return { text: response.text ?? "", topic, subtopic };
    }

    // Record the model's turn verbatim so thoughtSignature (required by
    // Gemini for tool use) and any thought/text parts are preserved.
    // For any functionCall part missing a signature (happens on the 2nd+
    // parallel call), inject Google's documented placeholder to pass validation.
    const modelContent = response.candidates?.[0]?.content;
    if (modelContent) {
      if (Array.isArray(modelContent.parts)) {
        for (const part of modelContent.parts) {
          if (part.functionCall && !part.thoughtSignature) {
            part.thoughtSignature = "skip_thought_signature_validator";
          }
        }
      }
      contents.push(modelContent);
    } else {
      contents.push({
        role: "model",
        parts: functionCalls.map((fc) => ({
          functionCall: { name: fc.name, args: fc.args },
          thoughtSignature: "skip_thought_signature_validator",
        })),
      });
    }

    // Execute each requested tool via MCP and build the function-response turn.
    const responseParts = [];
    for (const fc of functionCalls) {
      const result = await callMcpTool(fc.name, fc.args);

      if (fc.name === "search_questions" || fc.name === "get_formula") {
        const parsed = extractJson(result);
        if (Array.isArray(parsed) && parsed.length > 0) {
          topic = parsed[0].topic ?? topic;
          subtopic = parsed[0].subtopic ?? subtopic;
        }
      }

      responseParts.push({
        functionResponse: {
          name: fc.name,
          response: { result: extractJson(result) ?? result },
        },
      });
    }

    contents.push({ role: "user", parts: responseParts });
  }

  return { text: "Sorry, I couldn't complete that in time. Try rephrasing?", topic, subtopic };
}

app.message(async ({ message, say }) => {
  if (message.subtype || message.bot_id) return;

  const userText = message.text ?? "";
  if (!userText.trim()) return;

  try {
    const { text, topic, subtopic } = await runAgent(userText);

    // If the agent came back with genuinely nothing useful (no tool match and
    // no real answer text), send an honest "not in our database" message
    // instead of an empty or confusing reply.
    if (!text || !text.trim()) {
      await say(
        "I couldn't find anything on that in our question bank, and I'm not confident enough to answer from general knowledge. Try rephrasing, or ask your lecturer/class rep directly — I've logged this so it shows up in the topic-gap summary."
      );
      await callMcpTool("log_topic_gap", {
        topic: topic || "Unmatched",
        subtopic: subtopic || "Unmatched",
        resolved: false,
      }).catch(() => {}); // best-effort log; don't let a logging failure mask the real reply
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

// Minimal HTTP server so uptime pingers (e.g. UptimeRobot) can keep a
// free-tier host awake. Bolt runs in Socket Mode (outbound WebSocket) and does
// not otherwise listen for inbound HTTP, so without this there is nothing to ping.
// Render sets the PORT env var automatically; default to 3000 locally.
import http from "http";

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
  console.log("⚡️ ClassPilot is running (Gemini)!");
})();