# ClassPilot

**An AI study assistant that turns Slack class channels into a searchable, self-improving knowledge base — built for the Slack Agent Builder Challenge (Slack Agent for Good track).**

Class WhatsApp groups lose every answer to the scroll. ClassPilot moves the conversation into Slack and puts an AI agent behind it, so questions get answered instantly and every unresolved topic gets tracked — giving lecturers and class reps real visibility into where a class is actually struggling.

---

## Table of Contents

- [Problem](#problem)
- [What It Does](#what-it-does)
- [How It Works](#how-it-works)
- [Tech Stack](#tech-stack)
- [Impact](#impact)
- [Project Structure](#project-structure)
- [Setup](#setup)
- [Usage](#usage)
- [Required Hackathon Technology](#required-hackathon-technology)
- [Roadmap](#roadmap)

---

## Problem

Informal class group chats (usually WhatsApp) function as a course's de facto knowledge base — questions, past-question walkthroughs, formula references — but none of it is searchable, none of it is tracked, and the same questions get re-asked every semester because nothing persists in a useful way. Lecturers and class reps have no visibility into which topics students are actually struggling with until it shows up in exam results, which is too late to help.

## What It Does

ClassPilot lives inside a Slack class channel or DM. A student asks a question in natural language; the agent searches a curated question bank (real past questions and formula references, seeded from actual course material) and replies with a relevant, Slack-formatted answer. Every question is logged by topic and subtopic — resolved or not — so whoever manages the workspace can see which topics come up unresolved most often, and act on it directly instead of guessing.

## How It Works

```
Student (Slack channel/DM)
        │
        ▼
  Bolt Agent (Node.js, Socket Mode)
        │
        ▼
  Gemini (reasoning: which tool to call)
        │
        ▼
  MCP Server ── search_questions / get_formula / log_topic_gap
        │
        ▼
  Supabase (Postgres) ── questions table / topic_gaps table
        │
        ▼
  Block Kit response (answer + Resolved/Still stuck buttons)
        │
        ▼
  Topic-gap summary → admin/lecturer channel (/study-gaps)
```

## Tech Stack

| Layer | Technology |
|---|---|
| Agent runtime | Slack Bolt SDK (Node.js, Socket Mode) |
| Reasoning | Google Gemini (`gemini-flash-latest`) via `@google/genai` |
| Tool integration | Custom MCP server (`search_questions`, `get_formula`, `log_topic_gap`, `get_topic_gap_summary`) |
| Data | Supabase (Postgres) |
| UI | Slack Block Kit |
| Hosting | Render (with an HTTP health endpoint for uptime pinging) |

## Impact

- **Questions resolved on demand** — students get accurate answers pulled from real past questions and formulas, instead of waiting on whoever's online in the group chat.
- **Topic gaps surfaced, not guessed** — every question is logged by topic/subtopic, resolved or not. This turns informal confusion into visible, actionable data for a lecturer or class rep — a `/study-gaps` command surfaces the most frequently unresolved topics.
- **Scales across a full curriculum** — the question bank spans multiple 200-level Systems Engineering courses across both semesters, not just a single course, so the same infrastructure supports an entire academic year.

## Project Structure

```
classpilot/
├── app.js           # Bolt agent — message handling, Gemini reasoning loop, Block Kit UI
├── mcpServer.js     # MCP server exposing the four tools, backed by Supabase
├── package.json
├── .env.example     # Copy to .env and fill in real credentials
└── README.md
```

## Setup

### Prerequisites
- Node.js 18+
- A Slack workspace (sandbox) with a Slack app created
- A Supabase project with `questions` and `topic_gaps` tables
- A Gemini API key (Google AI Studio)

### 1. Clone and install
```bash
git clone <your-repo-url>
cd classpilot
npm install
```

### 2. Configure environment
```bash
cp .env.example .env
```
Fill in:
```
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
GEMINI_API_KEY=...
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_KEY=...
```

### 3. Slack app configuration
- Enable **Socket Mode**
- Bot Token Scopes: `chat:write`, `channels:history`, `im:history`, `im:write`, `app_mentions:read`, `commands`
- Event Subscriptions: `message.channels`, `message.im`, `app_mention`
- Slash command: `/study-gaps`
- Install the app to your workspace

### 4. Supabase schema
```sql
create table questions (
  id serial primary key,
  course_code text,
  course_title text,
  semester text,
  topic text,
  subtopic text,
  question text,
  answer text,
  formula_ref text
);

create table topic_gaps (
  id serial primary key,
  course_code text,
  topic text,
  subtopic text,
  resolved boolean,
  created_at timestamp default now()
);
```
Seed `questions` with your course data (CSV import via Supabase's Table Editor works well).

### 5. Run
```bash
npm start
```
You should see `⚡️ ClassPilot is running (Gemini)!`

## Usage

- **Ask a question** in any channel the bot is in, or DM it directly.
- **Give feedback** using the ✅ / ❌ buttons on each answer — this feeds the gap-tracking data.
- **Check topic gaps** with `/study-gaps` in any channel — returns the most frequently unresolved topics.

## Required Hackathon Technology

This project uses:
- **MCP server integration** — a custom MCP server (`mcpServer.js`) exposing four tools that the agent calls to search the question bank, retrieve formulas, and log/summarize topic gaps.
- **Slack AI capabilities** — the agent itself, running natively in Slack via Bolt, reasoning over student questions and responding conversationally.

## Roadmap

- Expand the question bank beyond the current course set
- Pilot with a real class group actively migrating off WhatsApp
- Close the loop on topic gaps — surfacing suggested resources or a lecturer nudge when a gap keeps recurring, not just the raw count