import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { githubRequest, handleGithubError, truncateIfNeeded } from "../services/github-client.js";
import { ownerRepoSchema, paginationSchema, responseFormatSchema } from "../schemas/common.js";
import { ResponseFormat, type GithubCommit } from "../types.js";
import { CHARACTER_LIMIT } from "../constants.js";

function formatCommit(c: GithubCommit): string {
  const author = c.commit.author;
  return [
    `### ${c.sha.slice(0, 7)} — ${c.commit.message.split("\n")[0]}`,
    `- **Author**: ${author?.name ?? c.author?.login ?? "—"} <${author?.email ?? ""}> — ${author?.date ?? ""}`,
    c.stats ? `- **Stats**: +${c.stats.additions} -${c.stats.deletions} (${c.stats.total} changes)` : null,
    `- **URL**: ${c.html_url}`,
    "",
  ]
    .filter((l) => l !== null)
    .join("\n");
}

export function registerCommitTools(server: McpServer): void {
  // ── github_list_commits ───────────────────────────────────────────────────
  server.registerTool(
    "github_list_commits",
    {
      title: "List Repository Commits",
      description: `List commits in a GitHub repository with optional filters.

Args:
  - owner (string): Repository owner
  - repo (string): Repository name
  - sha (string, optional): Branch name, tag, or commit SHA to start from (default: repo default branch)
  - path (string, optional): Only list commits that touched this file path
  - author (string, optional): Filter by GitHub login or email
  - since (string, optional): ISO 8601 timestamp — only commits after this date
  - until (string, optional): ISO 8601 timestamp — only commits before this date
  - page (number): Page number (default: 1)
  - per_page (number): Results per page, max 100 (default: 30)
  - response_format ('markdown'|'json'): Output format (default: 'markdown')

Returns: Commit history with SHA, message, author, and timestamps.`,
      inputSchema: ownerRepoSchema
        .extend({
          sha: z.string().optional().describe("Branch/tag/SHA to list from"),
          path: z.string().optional().describe("Only commits that touched this file path"),
          author: z.string().optional().describe("Filter by GitHub login or email"),
          since: z.string().optional().describe("ISO 8601 start timestamp"),
          until: z.string().optional().describe("ISO 8601 end timestamp"),
          response_format: responseFormatSchema,
        })
        .merge(paginationSchema),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ owner, repo, sha, path, author, since, until, page, per_page, response_format }) => {
      try {
        const commits = await githubRequest<GithubCommit[]>(
          "GET",
          `/repos/${owner}/${repo}/commits`,
          undefined,
          { sha, path, author, since, until, page, per_page }
        );

        const output = {
          count: commits.length,
          page,
          per_page,
          has_more: commits.length === per_page,
          next_page: commits.length === per_page ? page + 1 : undefined,
          commits: commits.map((c) => ({
            sha: c.sha,
            short_sha: c.sha.slice(0, 7),
            message: c.commit.message.split("\n")[0],
            author_name: c.commit.author?.name,
            author_login: c.author?.login,
            date: c.commit.author?.date,
            html_url: c.html_url,
          })),
        };

        let text: string;
        if (response_format === ResponseFormat.JSON) {
          text = JSON.stringify(output, null, 2);
        } else {
          const lines = [`# Commits in ${owner}/${repo} (page ${page})`, ""];
          for (const c of commits) lines.push(formatCommit(c));
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

  // ── github_get_commit ─────────────────────────────────────────────────────
  server.registerTool(
    "github_get_commit",
    {
      title: "Get Commit",
      description: `Fetch full details for a single commit including diff stats and changed files.

Args:
  - owner (string): Repository owner
  - repo (string): Repository name
  - ref (string): Commit SHA, branch name, or tag

Returns: Commit message, author, stats (+/- lines), and list of changed files.`,
      inputSchema: ownerRepoSchema.extend({
        ref: z.string().min(1).describe("Commit SHA, branch name, or tag"),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ owner, repo, ref }) => {
      try {
        const c = await githubRequest<GithubCommit>("GET", `/repos/${owner}/${repo}/commits/${ref}`);

        const lines = [
          `# Commit ${c.sha.slice(0, 7)}`,
          `**Message**: ${c.commit.message}`,
          `**Author**: ${c.commit.author?.name} <${c.commit.author?.email}> — ${c.commit.author?.date}`,
          c.stats ? `**Stats**: +${c.stats.additions} -${c.stats.deletions} (${c.stats.total} changes)` : null,
          `**URL**: ${c.html_url}`,
          "",
          "## Files changed",
        ].filter((l) => l !== null);

        for (const f of c.files ?? []) {
          lines.push(`- **${f.status}** \`${f.filename}\` (+${f.additions} -${f.deletions})`);
        }

        return {
          content: [{ type: "text", text: lines.join("\n") }],
          structuredContent: c,
        };
      } catch (e) {
        return { content: [{ type: "text", text: handleGithubError(e) }] };
      }
    }
  );

  // ── github_compare_commits ────────────────────────────────────────────────
  server.registerTool(
    "github_compare_commits",
    {
      title: "Compare Commits / Branches",
      description: `Compare two commits, branches, or tags in a repository. Useful for seeing what changed between releases or branches.

Args:
  - owner (string): Repository owner
  - repo (string): Repository name
  - base (string): Base commit, branch, or tag
  - head (string): Head commit, branch, or tag

Returns: Diff stats, list of commits in head but not base, and changed files.`,
      inputSchema: ownerRepoSchema.extend({
        base: z.string().min(1).describe("Base commit/branch/tag"),
        head: z.string().min(1).describe("Head commit/branch/tag"),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ owner, repo, base, head }) => {
      try {
        const data = await githubRequest<{
          status: string;
          ahead_by: number;
          behind_by: number;
          total_commits: number;
          commits: GithubCommit[];
          files: Array<{ filename: string; status: string; additions: number; deletions: number }>;
          html_url: string;
        }>("GET", `/repos/${owner}/${repo}/compare/${base}...${head}`);

        const lines = [
          `# Compare: ${base}...${head}`,
          `**Status**: ${data.status}  **Ahead by**: ${data.ahead_by}  **Behind by**: ${data.behind_by}`,
          `**Total commits**: ${data.total_commits}`,
          `**URL**: ${data.html_url}`,
          "",
          "## Commits in head not in base",
        ];
        for (const c of data.commits) {
          lines.push(`- \`${c.sha.slice(0, 7)}\` ${c.commit.message.split("\n")[0]} — ${c.author?.login ?? c.commit.author?.name ?? "—"}`);
        }
        if (data.files.length > 0) {
          lines.push("", "## Files changed");
          for (const f of data.files) {
            lines.push(`- **${f.status}** \`${f.filename}\` (+${f.additions} -${f.deletions})`);
          }
        }

        const output = {
          status: data.status,
          ahead_by: data.ahead_by,
          behind_by: data.behind_by,
          total_commits: data.total_commits,
          html_url: data.html_url,
          commits: data.commits.map((c) => ({ sha: c.sha.slice(0, 7), message: c.commit.message.split("\n")[0] })),
          files: data.files.map((f) => ({ filename: f.filename, status: f.status, additions: f.additions, deletions: f.deletions })),
        };

        return {
          content: [{ type: "text", text: truncateIfNeeded(lines.join("\n"), CHARACTER_LIMIT) }],
          structuredContent: output,
        };
      } catch (e) {
        return { content: [{ type: "text", text: handleGithubError(e) }] };
      }
    }
  );
}
