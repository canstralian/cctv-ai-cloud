import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { githubRequest, handleGithubError, truncateIfNeeded } from "../services/github-client.js";
import { ownerRepoSchema, paginationSchema, responseFormatSchema } from "../schemas/common.js";
import { ResponseFormat, type GithubRepo } from "../types.js";
import { CHARACTER_LIMIT } from "../constants.js";

function formatRepo(r: GithubRepo): string {
  const lines = [
    `## ${r.full_name}`,
    `- **URL**: ${r.html_url}`,
    `- **Description**: ${r.description ?? "—"}`,
    `- **Language**: ${r.language ?? "—"}`,
    `- **Stars**: ${r.stargazers_count}  **Forks**: ${r.forks_count}  **Open issues**: ${r.open_issues_count}`,
    `- **Default branch**: ${r.default_branch}`,
    `- **Private**: ${r.private}  **Fork**: ${r.fork}`,
    r.topics?.length ? `- **Topics**: ${r.topics.join(", ")}` : null,
    `- **Pushed**: ${r.pushed_at}`,
    "",
  ];
  return lines.filter((l) => l !== null).join("\n");
}

export function registerRepoTools(server: McpServer): void {
  // ── github_get_repo ───────────────────────────────────────────────────────
  server.registerTool(
    "github_get_repo",
    {
      title: "Get GitHub Repository",
      description: `Fetch detailed metadata for a single GitHub repository.

Returns full details: description, language, star/fork counts, topics, default branch, visibility, and timestamps.

Args:
  - owner (string): GitHub username or organization
  - repo (string): Repository name
  - response_format ('markdown'|'json'): Output format (default: 'markdown')

Returns (JSON schema):
  {
    "id": number,
    "full_name": string,
    "description": string|null,
    "html_url": string,
    "private": boolean,
    "fork": boolean,
    "default_branch": string,
    "stargazers_count": number,
    "forks_count": number,
    "open_issues_count": number,
    "language": string|null,
    "topics": string[],
    "created_at": string,
    "updated_at": string,
    "pushed_at": string,
    "owner": { "login": string, "html_url": string }
  }

Examples:
  - "Get info on the react repo" → owner="facebook", repo="react"
  - "Show me the default branch of torvalds/linux" → use this tool then check default_branch`,
      inputSchema: ownerRepoSchema.extend({ response_format: responseFormatSchema }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ owner, repo, response_format }) => {
      try {
        const r = await githubRequest<GithubRepo>("GET", `/repos/${owner}/${repo}`);
        if (response_format === ResponseFormat.JSON) {
          return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }], structuredContent: r };
        }
        return { content: [{ type: "text", text: formatRepo(r) }], structuredContent: r };
      } catch (e) {
        return { content: [{ type: "text", text: handleGithubError(e) }] };
      }
    }
  );

  // ── github_list_repos ─────────────────────────────────────────────────────
  server.registerTool(
    "github_list_repos",
    {
      title: "List User/Org Repositories",
      description: `List repositories for a GitHub user or organization.

Args:
  - owner (string): GitHub username or organization name
  - type ('all'|'owner'|'member'|'public'|'private'|'forks'|'sources'): Filter by repo type (default: 'all')
  - sort ('created'|'updated'|'pushed'|'full_name'): Sort order (default: 'updated')
  - direction ('asc'|'desc'): Sort direction (default: 'desc')
  - page (number): Page number (default: 1)
  - per_page (number): Results per page, max 100 (default: 30)
  - response_format ('markdown'|'json'): Output format (default: 'markdown')

Returns: List of repositories with metadata and pagination info.`,
      inputSchema: z
        .object({
          owner: z.string().min(1).describe("GitHub username or organization name"),
          type: z
            .enum(["all", "owner", "member", "public", "private", "forks", "sources"])
            .default("all")
            .describe("Filter by repository type"),
          sort: z
            .enum(["created", "updated", "pushed", "full_name"])
            .default("updated")
            .describe("Sort field"),
          direction: z.enum(["asc", "desc"]).default("desc").describe("Sort direction"),
          response_format: responseFormatSchema,
        })
        .merge(paginationSchema),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ owner, type, sort, direction, page, per_page, response_format }) => {
      try {
        const repos = await githubRequest<GithubRepo[]>("GET", `/users/${owner}/repos`, undefined, {
          type,
          sort,
          direction,
          page,
          per_page,
        });

        const output = {
          count: repos.length,
          page,
          per_page,
          has_more: repos.length === per_page,
          next_page: repos.length === per_page ? page + 1 : undefined,
          repos: repos.map((r) => ({
            full_name: r.full_name,
            html_url: r.html_url,
            description: r.description,
            language: r.language,
            private: r.private,
            fork: r.fork,
            stargazers_count: r.stargazers_count,
            forks_count: r.forks_count,
            open_issues_count: r.open_issues_count,
            default_branch: r.default_branch,
            pushed_at: r.pushed_at,
          })),
        };

        let text: string;
        if (response_format === ResponseFormat.JSON) {
          text = JSON.stringify(output, null, 2);
        } else {
          const lines = [`# Repositories for ${owner} (page ${page})`, ""];
          for (const r of repos) lines.push(formatRepo(r));
          if (output.has_more) lines.push(`\n*More results: use page=${page + 1}*`);
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

  // ── github_create_repo ────────────────────────────────────────────────────
  server.registerTool(
    "github_create_repo",
    {
      title: "Create GitHub Repository",
      description: `Create a new GitHub repository for the authenticated user.

Args:
  - name (string): Repository name (no spaces; use hyphens)
  - description (string, optional): Short description
  - private (boolean): Whether the repo is private (default: false)
  - auto_init (boolean): Initialize with a README (default: true)
  - gitignore_template (string, optional): Gitignore template name e.g. "Python", "Node"
  - license_template (string, optional): License template e.g. "mit", "apache-2.0"

Returns: Full repository metadata after creation.

Error Handling:
  - 422 if the repo name already exists or is invalid`,
      inputSchema: z.object({
        name: z.string().min(1).max(100).describe("Repository name"),
        description: z.string().max(255).optional().describe("Short description"),
        private: z.boolean().default(false).describe("Create as private repo"),
        auto_init: z.boolean().default(true).describe("Initialize with a README"),
        gitignore_template: z.string().optional().describe('Gitignore template e.g. "Python"'),
        license_template: z.string().optional().describe('License template e.g. "mit"'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (params) => {
      try {
        const r = await githubRequest<GithubRepo>("POST", "/user/repos", params);
        return {
          content: [{ type: "text", text: `Repository created: ${r.html_url}\n\n${formatRepo(r)}` }],
          structuredContent: r,
        };
      } catch (e) {
        return { content: [{ type: "text", text: handleGithubError(e) }] };
      }
    }
  );

  // ── github_search_repos ───────────────────────────────────────────────────
  server.registerTool(
    "github_search_repos",
    {
      title: "Search GitHub Repositories",
      description: `Search GitHub repositories using GitHub's search syntax.

Args:
  - query (string): Search query. Supports qualifiers like language:python, stars:>100, topic:machine-learning, user:octocat
  - sort ('stars'|'forks'|'help-wanted-issues'|'updated'): Sort field (default: 'best-match')
  - order ('asc'|'desc'): Sort order (default: 'desc')
  - page (number): Page number (default: 1)
  - per_page (number): Results per page, max 100 (default: 30)
  - response_format ('markdown'|'json'): Output format (default: 'markdown')

Returns: Matching repositories with total count and pagination.

Examples:
  - Find Python ML repos with 1k+ stars: query="language:python topic:machine-learning stars:>1000"
  - Find a user's repos: query="user:torvalds"`,
      inputSchema: z
        .object({
          query: z.string().min(1).describe("GitHub search query string"),
          sort: z
            .enum(["stars", "forks", "help-wanted-issues", "updated"])
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
        const result = await githubRequest<{ total_count: number; items: GithubRepo[] }>(
          "GET",
          "/search/repositories",
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
          repos: result.items.map((r) => ({
            full_name: r.full_name,
            html_url: r.html_url,
            description: r.description,
            language: r.language,
            stargazers_count: r.stargazers_count,
            forks_count: r.forks_count,
            topics: r.topics,
            updated_at: r.updated_at,
          })),
        };

        let text: string;
        if (response_format === ResponseFormat.JSON) {
          text = JSON.stringify(output, null, 2);
        } else {
          const lines = [`# Search Results for "${query}"`, `*${result.total_count} repositories found (page ${page})*`, ""];
          for (const r of result.items) lines.push(formatRepo(r));
          if (output.has_more) lines.push(`\n*More results: use page=${page + 1}*`);
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
}
