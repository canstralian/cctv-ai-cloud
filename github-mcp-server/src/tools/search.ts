import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { githubRequest, handleGithubError, truncateIfNeeded } from "../services/github-client.js";
import { paginationSchema, responseFormatSchema } from "../schemas/common.js";
import { ResponseFormat, type GithubIssue } from "../types.js";
import { CHARACTER_LIMIT } from "../constants.js";

export function registerSearchTools(server: McpServer): void {
  // ── github_search_code ────────────────────────────────────────────────────
  server.registerTool(
    "github_search_code",
    {
      title: "Search Code on GitHub",
      description: `Search for code across GitHub repositories using GitHub's code search syntax.

Args:
  - query (string): Code search query. Supports qualifiers:
      repo:owner/name   — search in a specific repo
      path:src/         — match files in a path
      extension:ts      — match file extension
      language:python   — filter by language
      filename:index.ts — match exact filename
  - page (number): Page number (default: 1)
  - per_page (number): Results per page, max 100 (default: 30)
  - response_format ('markdown'|'json'): Output format (default: 'markdown')

Returns: Matching code files with repo, path, and URL. Does NOT return file content — use github_get_file_contents to read a matched file.

Examples:
  - Find all Python files using asyncio in a repo: query="import asyncio repo:owner/repo language:python"
  - Find Dockerfiles: query="filename:Dockerfile"`,
      inputSchema: z
        .object({
          query: z.string().min(1).describe("Code search query with optional qualifiers"),
          response_format: responseFormatSchema,
        })
        .merge(paginationSchema),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ query, page, per_page, response_format }) => {
      try {
        const result = await githubRequest<{
          total_count: number;
          items: Array<{
            name: string;
            path: string;
            sha: string;
            html_url: string;
            repository: { full_name: string; html_url: string };
          }>;
        }>("GET", "/search/code", undefined, { q: query, page, per_page });

        const output = {
          total_count: result.total_count,
          count: result.items.length,
          page,
          per_page,
          has_more: result.total_count > page * per_page,
          next_page: result.total_count > page * per_page ? page + 1 : undefined,
          items: result.items.map((item) => ({
            name: item.name,
            path: item.path,
            sha: item.sha,
            html_url: item.html_url,
            repo: item.repository.full_name,
          })),
        };

        let text: string;
        if (response_format === ResponseFormat.JSON) {
          text = JSON.stringify(output, null, 2);
        } else {
          const lines = [`# Code Search: "${query}"`, `*${result.total_count} results (page ${page})*`, ""];
          for (const item of result.items) {
            lines.push(`## \`${item.path}\` in ${item.repository.full_name}`);
            lines.push(`- **URL**: ${item.html_url}`, "");
          }
          if (output.has_more) lines.push(`*More: use page=${page + 1}*`);
          text = lines.join("\n");
        }

        return {
          content: [{ type: "text", text: truncateIfNeeded(text, CHARACTER_LIMIT) }],
          structuredContent: output,
        };
      } catch (e) {
        return { content: [{ type: "text", text: handleGithubError(e) }] };
      }
    }
  );

  // ── github_search_issues ──────────────────────────────────────────────────
  server.registerTool(
    "github_search_issues",
    {
      title: "Search Issues and Pull Requests",
      description: `Search issues and pull requests across GitHub using search qualifiers.

Args:
  - query (string): Search query. Supports qualifiers:
      repo:owner/name     — specific repo
      is:issue / is:pr    — filter to issues or PRs
      is:open / is:closed — filter by state
      label:bug           — filter by label
      author:login        — filter by author
      assignee:login      — filter by assignee
      milestone:title     — filter by milestone
      language:python     — filter by repo language
      created:>2024-01-01 — date filters
  - sort ('comments'|'reactions'|'reactions-+1'|'reactions--1'|'author-date'|'created'|'updated', optional): Sort field
  - order ('asc'|'desc'): Sort order (default: 'desc')
  - page (number): Page number (default: 1)
  - per_page (number): Results per page, max 100 (default: 30)
  - response_format ('markdown'|'json'): Output format (default: 'markdown')

Returns: Matching issues/PRs with number, title, state, labels, and URL.`,
      inputSchema: z
        .object({
          query: z.string().min(1).describe("Issue/PR search query with optional qualifiers"),
          sort: z
            .enum(["comments", "reactions", "reactions-+1", "reactions--1", "author-date", "created", "updated"])
            .optional()
            .describe("Sort field (omit for best-match)"),
          order: z.enum(["asc", "desc"]).default("desc").describe("Sort order"),
          response_format: responseFormatSchema,
        })
        .merge(paginationSchema),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ query, sort, order, page, per_page, response_format }) => {
      try {
        const result = await githubRequest<{ total_count: number; items: GithubIssue[] }>(
          "GET",
          "/search/issues",
          undefined,
          { q: query, sort, order, page, per_page }
        );

        const output = {
          total_count: result.total_count,
          count: result.items.length,
          page,
          per_page,
          has_more: result.total_count > page * per_page,
          next_page: result.total_count > page * per_page ? page + 1 : undefined,
          items: result.items.map((i) => ({
            number: i.number,
            title: i.title,
            state: i.state,
            html_url: i.html_url,
            user: i.user?.login,
            labels: i.labels.map((l) => l.name),
            comments: i.comments,
            created_at: i.created_at,
            updated_at: i.updated_at,
            is_pull_request: !!i.pull_request,
          })),
        };

        let text: string;
        if (response_format === ResponseFormat.JSON) {
          text = JSON.stringify(output, null, 2);
        } else {
          const lines = [`# Issue/PR Search: "${query}"`, `*${result.total_count} results (page ${page})*`, ""];
          for (const i of result.items) {
            const kind = i.pull_request ? "PR" : "Issue";
            lines.push(`## ${kind} #${i.number}: ${i.title}`);
            lines.push(`- **State**: ${i.state}  **Author**: ${i.user?.login ?? "—"}  **Comments**: ${i.comments}`);
            lines.push(`- **Labels**: ${i.labels.map((l) => l.name).join(", ") || "—"}`);
            lines.push(`- **URL**: ${i.html_url}`, "");
          }
          if (output.has_more) lines.push(`*More: use page=${page + 1}*`);
          text = lines.join("\n");
        }

        return {
          content: [{ type: "text", text: truncateIfNeeded(text, CHARACTER_LIMIT) }],
          structuredContent: output,
        };
      } catch (e) {
        return { content: [{ type: "text", text: handleGithubError(e) }] };
      }
    }
  );

  // ── github_search_users ───────────────────────────────────────────────────
  server.registerTool(
    "github_search_users",
    {
      title: "Search GitHub Users",
      description: `Search for GitHub users and organizations.

Args:
  - query (string): Search query. Supports qualifiers:
      type:user / type:org  — filter to users or organizations
      location:Berlin       — filter by location
      language:rust         — users whose repos use this language
      repos:>10             — filter by repo count
      followers:>100        — filter by follower count
  - sort ('followers'|'repositories'|'joined', optional): Sort field (omit for best-match)
  - order ('asc'|'desc'): Sort order (default: 'desc')
  - page (number): Page number (default: 1)
  - per_page (number): Results per page, max 100 (default: 30)
  - response_format ('markdown'|'json'): Output format (default: 'markdown')`,
      inputSchema: z
        .object({
          query: z.string().min(1).describe("User/org search query"),
          sort: z.enum(["followers", "repositories", "joined"]).optional().describe("Sort field"),
          order: z.enum(["asc", "desc"]).default("desc").describe("Sort order"),
          response_format: responseFormatSchema,
        })
        .merge(paginationSchema),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ query, sort, order, page, per_page, response_format }) => {
      try {
        const result = await githubRequest<{
          total_count: number;
          items: Array<{ login: string; id: number; html_url: string; avatar_url: string; type: string; score: number }>;
        }>("GET", "/search/users", undefined, { q: query, sort, order, page, per_page });

        const output = {
          total_count: result.total_count,
          count: result.items.length,
          page,
          per_page,
          has_more: result.total_count > page * per_page,
          next_page: result.total_count > page * per_page ? page + 1 : undefined,
          users: result.items.map((u) => ({
            login: u.login,
            id: u.id,
            type: u.type,
            html_url: u.html_url,
          })),
        };

        let text: string;
        if (response_format === ResponseFormat.JSON) {
          text = JSON.stringify(output, null, 2);
        } else {
          const lines = [`# User Search: "${query}"`, `*${result.total_count} results (page ${page})*`, ""];
          for (const u of result.items) {
            lines.push(`- **${u.login}** (${u.type}) — ${u.html_url}`);
          }
          if (output.has_more) lines.push(`\n*More: use page=${page + 1}*`);
          text = lines.join("\n");
        }

        return {
          content: [{ type: "text", text }],
          structuredContent: output,
        };
      } catch (e) {
        return { content: [{ type: "text", text: handleGithubError(e) }] };
      }
    }
  );
}
