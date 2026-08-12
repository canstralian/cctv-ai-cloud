#!/usr/bin/env node
/**
 * GitHub MCP Server
 *
 * Provides tools for LLMs to interact with the GitHub API:
 * repositories, issues, pull requests, files, branches, commits,
 * GitHub Actions, releases, users, and search.
 *
 * Authentication: Set GITHUB_TOKEN environment variable (personal access token
 * or fine-grained token with required scopes).
 *
 * Transport: stdio by default; set TRANSPORT=http for streamable HTTP on PORT (default 3000).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";

import { registerRepoTools } from "./tools/repos.js";
import { registerIssueTools } from "./tools/issues.js";
import { registerPRTools } from "./tools/pull_requests.js";
import { registerFileTools } from "./tools/files.js";
import { registerBranchTools } from "./tools/branches.js";
import { registerCommitTools } from "./tools/commits.js";
import { registerActionsTools } from "./tools/actions.js";
import { registerSearchTools } from "./tools/search.js";
import { registerUserTools } from "./tools/users.js";

function createServer(): McpServer {
  const server = new McpServer({
    name: "github-mcp-server",
    version: "1.0.0",
  });

  registerRepoTools(server);
  registerIssueTools(server);
  registerPRTools(server);
  registerFileTools(server);
  registerBranchTools(server);
  registerCommitTools(server);
  registerActionsTools(server);
  registerSearchTools(server);
  registerUserTools(server);

  return server;
}

async function runStdio(): Promise<void> {
  if (!process.env.GITHUB_TOKEN) {
    console.error("ERROR: GITHUB_TOKEN environment variable is required");
    process.exit(1);
  }

  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("GitHub MCP server running via stdio");
}

async function runHTTP(): Promise<void> {
  if (!process.env.GITHUB_TOKEN) {
    console.error("ERROR: GITHUB_TOKEN environment variable is required");
    process.exit(1);
  }

  const app = express();
  app.use(express.json());

  app.post("/mcp", async (req, res) => {
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => transport.close());
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  app.get("/health", (_req, res) => res.json({ status: "ok", server: "github-mcp-server" }));

  const port = parseInt(process.env.PORT ?? "3000", 10);
  app.listen(port, () => {
    console.error(`GitHub MCP server running on http://localhost:${port}/mcp`);
  });
}

const transport = process.env.TRANSPORT ?? "stdio";
if (transport === "http") {
  runHTTP().catch((err) => {
    console.error("Server error:", err);
    process.exit(1);
  });
} else {
  runStdio().catch((err) => {
    console.error("Server error:", err);
    process.exit(1);
  });
}
