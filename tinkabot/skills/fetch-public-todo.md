---
name: Fetch public TODO
description: Pull a TODO item from the wrapped public API and summarize the result.
allowed-tools:
  - mcp__tinkabot__fetch_todo
---

# Fetch public TODO

## Goal
Use tinkabot MCP integration to fetch a single TODO item by id and return a short summary.

## Inputs
- `id` (number, required): TODO id between 1 and 200.

## Steps
1. Call `mcp__tinkabot__fetch_todo` with the provided `id`.
2. Confirm `todo.id`, `todo.title`, and `todo.completed` are present.
3. Return a concise summary with status and title.

## Output
- Structured summary containing `id`, `title`, `completed`, and `fetchedAt`.
