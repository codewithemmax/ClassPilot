/**
 * ClassPilot MCP Server (JavaScript / ESM)
 *
 * Exposes four tools to the Slack agent:
 *   - search_questions(query, course_code?)
 *   - get_formula(topic, course_code?)
 *   - log_topic_gap(topic, subtopic, resolved, course_code?)
 *   - get_topic_gap_summary(course_code?, limit?)
 *
 * Requires:
 *   npm install @modelcontextprotocol/sdk @supabase/supabase-js dotenv zod
 *
 * .env:
 *   SUPABASE_URL=your-supabase-project-url
 *   SUPABASE_KEY=your-supabase-service-role-or-anon-key
 *
 * Note: package.json must have "type": "module" for the import syntax below.
 */

import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  throw new Error("Missing SUPABASE_URL or SUPABASE_KEY in environment");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const server = new McpServer({
  name: "classpilot",
  version: "1.0.0",
});

server.tool(
  "search_questions",
  "Search the question bank for entries matching a topic or keyword.",
  {
    query: z.string().describe("keyword or phrase to search for, e.g. 'SFEE' or 'entropy'"),
    course_code: z.string().optional().describe("optional course code, e.g. 'GET 206'"),
  },
  async ({ query, course_code }) => {
    let q = supabase.from("questions").select("*");

    if (course_code) {
      q = q.eq("course_code", course_code);
    }

    q = q.or(
      `topic.ilike.%${query}%,subtopic.ilike.%${query}%,question.ilike.%${query}%`
    );

    const { data, error } = await q.limit(5);

    if (error) {
      return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
    }

    return { content: [{ type: "text", text: JSON.stringify(data) }] };
  }
);

server.tool(
  "get_formula",
  "Retrieve the formula reference(s) for a given topic.",
  {
    topic: z.string().describe("the topic name, e.g. 'Carnot Cycle'"),
    course_code: z.string().optional(),
  },
  async ({ topic, course_code }) => {
    let q = supabase
      .from("questions")
      .select("topic, subtopic, formula_ref")
      .ilike("topic", `%${topic}%`)
      .not("formula_ref", "is", null);

    if (course_code) {
      q = q.eq("course_code", course_code);
    }

    const { data, error } = await q.limit(5);

    if (error) {
      return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
    }

    return { content: [{ type: "text", text: JSON.stringify(data) }] };
  }
);

server.tool(
  "log_topic_gap",
  "Log whether a student's question on a topic/subtopic was resolved.",
  {
    topic: z.string(),
    subtopic: z.string(),
    resolved: z.boolean(),
    course_code: z.string().optional(),
  },
  async ({ topic, subtopic, resolved, course_code }) => {
    const row = { topic, subtopic, resolved };
    if (course_code) row.course_code = course_code;

    const { data, error } = await supabase.from("topic_gaps").insert(row).select();

    if (error) {
      return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
    }

    return { content: [{ type: "text", text: JSON.stringify(data?.[0] ?? {}) }] };
  }
);

server.tool(
  "get_topic_gap_summary",
  "Retrieve the most frequently unresolved topics, for the admin/lecturer summary.",
  {
    course_code: z.string().optional(),
    limit: z.number().optional().default(5),
  },
  async ({ course_code, limit }) => {
    let q = supabase.from("topic_gaps").select("topic, subtopic, resolved").eq("resolved", false);

    if (course_code) {
      q = q.eq("course_code", course_code);
    }

    const { data, error } = await q;

    if (error) {
      return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
    }

    const counts = {};
    for (const row of data ?? []) {
      const key = `${row.topic} — ${row.subtopic}`;
      counts[key] = (counts[key] ?? 0) + 1;
    }

    const sorted = Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([topic_subtopic, unresolved_count]) => ({ topic_subtopic, unresolved_count }));

    return { content: [{ type: "text", text: JSON.stringify(sorted) }] };
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("MCP server error:", err);
  process.exit(1);
});