import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { githubRequest, handleGithubError, truncateIfNeeded } from "../services/github-client.js";
import { ownerRepoSchema, paginationSchema, responseFormatSchema } from "../schemas/common.js";
import { ResponseFormat, type GithubPR, type GithubComment } from "../types.js";
import { CHARACTER_LIMIT } from "../constants.js";

function formatPR(pr: GithubPR): string {
  const labels = pr.labels.map((l) => l.name).join(", ") || "—";
  const reviewers = pr.requested_reviewers.map((r) => r.login).join(", ") || "—";
  return [
    `## PR #${pr.number}: ${pr.title}`,
    `- **State**: ${pr.state}${pr.draft ? " (draft)" : ""}${pr.merged ? " (merged)" : ""}`,
    `- **Author**: ${pr.user?.login ?? "—"}  **Reviewers**: ${reviewers}`,
    `- **Labels**: ${labels}`,
    `- **Branch**: \`${pr.head.ref}\` → \`${pr.base.ref}\``,
    `- **Changes**: +${pr.additions} -${pr.deletions} in ${pr.changed_files} files (${pr.commits} commits)`,
    `- **Created**: ${pr.created_at}  **Updated**: ${pr.updated_at}`,
    pr.merged_at ? `- **Merged**: ${pr.merged_at}` : null,
    `- **URL**: ${pr.html_url}`,
    pr.body ? `\n${pr.body.slice(0, 500)}${pr.body.length > 500 ? "\n…(truncated)" : ""}` : "",
    "",
  ]
    .filter((l) => l !== null)
    .join("\n");
}

export function registerPRTools(server: McpServer): void {
  // ── github_list_pull_requests ─────────────────────────────────────────────
  server.registerTool(
    "github_list_pull_requests",
    {
      title: "List Pull Requests",
      description: `List pull requests for a GitHub repository.

Args:
  - owner (string): Repository owner
  - repo (string): Repository name
  - state ('open'|'closed'|'all'): Filter by state (default: 'open')
  - head (string, optional): Filter by head branch — format 'user:branch-name'
  - base (string, optional): Filter by base branch name
  - sort ('created'|'updated'|'popularity'|'long-running'): Sort field (default: 'created')
  - direction ('asc'|'desc'): Sort direction (default: 'desc')
  - page (number): Page number (default: 1)
  - per_page (number): Results per page, max 100 (default: 30)
  - response_format ('markdown'|'json'): Output format (default: 'markdown')`,
      inputSchema: ownerRepoSchema
        .extend({
          state: z.enum(["open", "closed", "all"]).default("open").describe("PR state filter"),
          head: z.string().optional().describe("Filter by head branch (format: 'user:branch')"),
          base: z.string().optional().describe("Filter by base branch name"),
          sort: z.enum(["created", "updated", "popularity", "long-running"]).default("created").describe("Sort field"),
          direction: z.enum(["asc", "desc"]).default("desc").describe("Sort direction"),
          response_format: responseFormatSchema,
        })
        .merge(paginationSchema),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ owner, repo, state, head, base, sort, direction, page, per_page, response_format }) => {
      try {
        const prs = await githubRequest<GithubPR[]>(
          "GET",
          `/repos/${owner}/${repo}/pulls`,
          undefined,
          { state, head, base, sort, direction, page, per_page }
        );

        const output = {
          count: prs.length,
          page,
          per_page,
          has_more: prs.length === per_page,
          next_page: prs.length === per_page ? page + 1 : undefined,
          pull_requests: prs.map((pr) => ({
            number: pr.number,
            title: pr.title,
            state: pr.state,
            draft: pr.draft,
            merged: pr.merged,
            html_url: pr.html_url,
            user: pr.user?.login,
            head_ref: pr.head.ref,
            base_ref: pr.base.ref,
            labels: pr.labels.map((l) => l.name),
            commits: pr.commits,
            additions: pr.additions,
            deletions: pr.deletions,
            changed_files: pr.changed_files,
            created_at: pr.created_at,
            updated_at: pr.updated_at,
          })),
        };

        let text: string;
        if (response_format === ResponseFormat.JSON) {
          text = JSON.stringify(output, null, 2);
        } else {
          const lines = [`# Pull Requests for ${owner}/${repo} (${state}, page ${page})`, ""];
          for (const pr of prs) lines.push(formatPR(pr));
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

  // ── github_get_pull_request ───────────────────────────────────────────────
  server.registerTool(
    "github_get_pull_request",
    {
      title: "Get Pull Request",
      description: `Fetch full details for a single pull request including diff stats, merge status, and review state.

Args:
  - owner (string): Repository owner
  - repo (string): Repository name
  - pull_number (number): Pull request number
  - response_format ('markdown'|'json'): Output format (default: 'markdown')`,
      inputSchema: ownerRepoSchema.extend({
        pull_number: z.number().int().min(1).describe("Pull request number"),
        response_format: responseFormatSchema,
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ owner, repo, pull_number, response_format }) => {
      try {
        const pr = await githubRequest<GithubPR>("GET", `/repos/${owner}/${repo}/pulls/${pull_number}`);
        if (response_format === ResponseFormat.JSON) {
          return { content: [{ type: "text", text: JSON.stringify(pr, null, 2) }], structuredContent: pr };
        }
        return { content: [{ type: "text", text: formatPR(pr) }], structuredContent: pr };
      } catch (e) {
        return { content: [{ type: "text", text: handleGithubError(e) }] };
      }
    }
  );

  // ── github_create_pull_request ────────────────────────────────────────────
  server.registerTool(
    "github_create_pull_request",
    {
      title: "Create Pull Request",
      description: `Open a new pull request in a GitHub repository.

Args:
  - owner (string): Repository owner
  - repo (string): Repository name
  - title (string): PR title
  - head (string): Branch with changes (format: 'branch-name' or 'fork-owner:branch')
  - base (string): Branch to merge into (e.g. 'main')
  - body (string, optional): PR description in Markdown
  - draft (boolean): Create as draft PR (default: false)
  - maintainer_can_modify (boolean): Allow maintainers to push (default: true)

Returns: Created PR number, URL, and metadata.

Error Handling:
  - 422 if head branch doesn't exist or there are no commits between branches`,
      inputSchema: ownerRepoSchema.extend({
        title: z.string().min(1).max(256).describe("PR title"),
        head: z.string().min(1).describe("Source branch (or 'fork:branch')"),
        base: z.string().min(1).describe("Target branch to merge into"),
        body: z.string().optional().describe("PR description in Markdown"),
        draft: z.boolean().default(false).describe("Create as draft PR"),
        maintainer_can_modify: z.boolean().default(true).describe("Allow maintainers to push to head branch"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ owner, repo, title, head, base, body, draft, maintainer_can_modify }) => {
      try {
        const pr = await githubRequest<GithubPR>("POST", `/repos/${owner}/${repo}/pulls`, {
          title,
          head,
          base,
          body,
          draft,
          maintainer_can_modify,
        });
        return {
          content: [{ type: "text", text: `Pull request created: ${pr.html_url}\n\n${formatPR(pr)}` }],
          structuredContent: pr,
        };
      } catch (e) {
        return { content: [{ type: "text", text: handleGithubError(e) }] };
      }
    }
  );

  // ── github_merge_pull_request ─────────────────────────────────────────────
  server.registerTool(
    "github_merge_pull_request",
    {
      title: "Merge Pull Request",
      description: `Merge an open pull request.

Args:
  - owner (string): Repository owner
  - repo (string): Repository name
  - pull_number (number): Pull request number
  - commit_title (string, optional): Title for the merge commit
  - commit_message (string, optional): Extra detail in the merge commit message
  - merge_method ('merge'|'squash'|'rebase'): Merge strategy (default: 'merge')
  - sha (string, optional): Expected HEAD SHA to guard against race conditions

Returns: Merge commit SHA and confirmation.

Error Handling:
  - 405 if the PR is not mergeable (conflicts, branch protection, etc.)
  - 409 if the SHA doesn't match the current head`,
      inputSchema: ownerRepoSchema.extend({
        pull_number: z.number().int().min(1).describe("Pull request number"),
        commit_title: z.string().optional().describe("Merge commit title"),
        commit_message: z.string().optional().describe("Merge commit extra message"),
        merge_method: z.enum(["merge", "squash", "rebase"]).default("merge").describe("Merge strategy"),
        sha: z.string().optional().describe("Expected current HEAD SHA of the PR"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ owner, repo, pull_number, commit_title, commit_message, merge_method, sha }) => {
      try {
        const result = await githubRequest<{ sha: string; merged: boolean; message: string }>(
          "PUT",
          `/repos/${owner}/${repo}/pulls/${pull_number}/merge`,
          { commit_title, commit_message, merge_method, sha }
        );
        return {
          content: [
            {
              type: "text",
              text: result.merged
                ? `PR #${pull_number} merged successfully. Commit SHA: ${result.sha}`
                : `Merge failed: ${result.message}`,
            },
          ],
          structuredContent: result,
        };
      } catch (e) {
        return { content: [{ type: "text", text: handleGithubError(e) }] };
      }
    }
  );

  // ── github_list_pr_reviews ────────────────────────────────────────────────
  server.registerTool(
    "github_list_pr_reviews",
    {
      title: "List Pull Request Reviews",
      description: `List all reviews submitted on a pull request.

Args:
  - owner (string): Repository owner
  - repo (string): Repository name
  - pull_number (number): Pull request number
  - page (number): Page number (default: 1)
  - per_page (number): Results per page, max 100 (default: 30)
  - response_format ('markdown'|'json'): Output format (default: 'markdown')

Returns: List of reviews with reviewer, state (APPROVED, CHANGES_REQUESTED, COMMENTED, DISMISSED), and body.`,
      inputSchema: ownerRepoSchema
        .extend({
          pull_number: z.number().int().min(1).describe("Pull request number"),
          response_format: responseFormatSchema,
        })
        .merge(paginationSchema),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ owner, repo, pull_number, page, per_page, response_format }) => {
      try {
        const reviews = await githubRequest<GithubComment[]>(
          "GET",
          `/repos/${owner}/${repo}/pulls/${pull_number}/reviews`,
          undefined,
          { page, per_page }
        );

        const output = { count: reviews.length, page, per_page, reviews };

        let text: string;
        if (response_format === ResponseFormat.JSON) {
          text = JSON.stringify(output, null, 2);
        } else {
          const lines = [`# Reviews on PR #${pull_number} in ${owner}/${repo}`, ""];
          for (const r of reviews as unknown as Array<{ user?: { login: string }; state: string; body: string; submitted_at: string; html_url: string }>) {
            lines.push(`### ${r.user?.login ?? "—"} — **${r.state}** — ${r.submitted_at}`);
            if (r.body) lines.push(r.body.slice(0, 300));
            lines.push(`[View](${r.html_url})`, "");
          }
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

  // ── github_list_pr_files ──────────────────────────────────────────────────
  server.registerTool(
    "github_list_pr_files",
    {
      title: "List Files Changed in PR",
      description: `List files changed in a pull request with diff stats.

Args:
  - owner (string): Repository owner
  - repo (string): Repository name
  - pull_number (number): Pull request number
  - page (number): Page number (default: 1)
  - per_page (number): Results per page, max 100 (default: 30)

Returns: Files with status (added/modified/removed/renamed), additions, deletions, and patch excerpt.`,
      inputSchema: ownerRepoSchema.extend({ pull_number: z.number().int().min(1).describe("PR number") }).merge(paginationSchema),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ owner, repo, pull_number, page, per_page }) => {
      try {
        const files = await githubRequest<Array<{ filename: string; status: string; additions: number; deletions: number; changes: number; patch?: string }>>(
          "GET",
          `/repos/${owner}/${repo}/pulls/${pull_number}/files`,
          undefined,
          { page, per_page }
        );

        const output = {
          count: files.length,
          page,
          per_page,
          has_more: files.length === per_page,
          files: files.map((f) => ({
            filename: f.filename,
            status: f.status,
            additions: f.additions,
            deletions: f.deletions,
            changes: f.changes,
          })),
        };

        const lines = [`# Files changed in ${owner}/${repo} PR #${pull_number} (page ${page})`, ""];
        for (const f of files) {
          lines.push(`- **${f.status}** \`${f.filename}\` (+${f.additions} -${f.deletions})`);
        }
        if (output.has_more) lines.push(`\n*More: use page=${page + 1}*`);

        return {
          content: [{ type: "text", text: lines.join("\n") }],
          structuredContent: output,
        };
      } catch (e) {
        return { content: [{ type: "text", text: handleGithubError(e) }] };
      }
    }
  );
}
