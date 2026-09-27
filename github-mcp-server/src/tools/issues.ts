import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { githubRequest, handleGithubError, truncateIfNeeded } from "../services/github-client.js";
import { ownerRepoSchema, paginationSchema, responseFormatSchema } from "../schemas/common.js";
import { ResponseFormat, type GithubComment, type GithubIssue } from "../types.js";
import { CHARACTER_LIMIT } from "../constants.js";

function formatIssue(i: GithubIssue): string {
  const labels = i.labels.map((l) => l.name).join(", ") || "—";
  const assignees = i.assignees.map((a) => a.login).join(", ") || "—";
  return [
    `## #${i.number}: ${i.title}`,
    `- **State**: ${i.state}  **Comments**: ${i.comments}`,
    `- **Author**: ${i.user?.login ?? "—"}  **Assignees**: ${assignees}`,
    `- **Labels**: ${labels}`,
    i.milestone ? `- **Milestone**: ${i.milestone.title}` : null,
    `- **Created**: ${i.created_at}  **Updated**: ${i.updated_at}`,
    `- **URL**: ${i.html_url}`,
    i.body ? `\n${i.body.slice(0, 500)}${i.body.length > 500 ? "\n…(truncated)" : ""}` : "",
    "",
  ]
    .filter((l) => l !== null)
    .join("\n");
}

export function registerIssueTools(server: McpServer): void {
  // ── github_list_issues ────────────────────────────────────────────────────
  server.registerTool(
    "github_list_issues",
    {
      title: "List Repository Issues",
      description: `List issues for a GitHub repository with filtering options.

Note: Pull requests are also issues in GitHub's API — use 'is_pull_request: false' filter or check for pull_request field to exclude them.

Args:
  - owner (string): Repository owner
  - repo (string): Repository name
  - state ('open'|'closed'|'all'): Filter by state (default: 'open')
  - labels (string, optional): Comma-separated label names to filter by
  - assignee (string, optional): Filter by assignee login ('none' for unassigned)
  - milestone (string, optional): Milestone number or '*' for any
  - sort ('created'|'updated'|'comments'): Sort field (default: 'created')
  - direction ('asc'|'desc'): Sort direction (default: 'desc')
  - since (string, optional): ISO 8601 timestamp — only issues updated after this date
  - page (number): Page number (default: 1)
  - per_page (number): Results per page, max 100 (default: 30)
  - response_format ('markdown'|'json'): Output format (default: 'markdown')

Returns: List of issues with metadata and pagination info.`,
      inputSchema: ownerRepoSchema
        .extend({
          state: z.enum(["open", "closed", "all"]).default("open").describe("Issue state filter"),
          labels: z.string().optional().describe("Comma-separated label names"),
          assignee: z.string().optional().describe("Assignee login (use 'none' for unassigned)"),
          milestone: z.string().optional().describe("Milestone number or '*' for any"),
          sort: z.enum(["created", "updated", "comments"]).default("created").describe("Sort field"),
          direction: z.enum(["asc", "desc"]).default("desc").describe("Sort direction"),
          since: z.string().optional().describe("ISO 8601 timestamp — only issues updated after this"),
          response_format: responseFormatSchema,
        })
        .merge(paginationSchema),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ owner, repo, state, labels, assignee, milestone, sort, direction, since, page, per_page, response_format }) => {
      try {
        const issues = await githubRequest<GithubIssue[]>(
          "GET",
          `/repos/${owner}/${repo}/issues`,
          undefined,
          { state, labels, assignee, milestone, sort, direction, since, page, per_page }
        );

        const output = {
          count: issues.length,
          page,
          per_page,
          has_more: issues.length === per_page,
          next_page: issues.length === per_page ? page + 1 : undefined,
          issues: issues.map((i) => ({
            number: i.number,
            title: i.title,
            state: i.state,
            html_url: i.html_url,
            user: i.user?.login,
            labels: i.labels.map((l) => l.name),
            assignees: i.assignees.map((a) => a.login),
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
          const lines = [`# Issues for ${owner}/${repo} (${state}, page ${page})`, ""];
          for (const i of issues) lines.push(formatIssue(i));
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

  // ── github_get_issue ──────────────────────────────────────────────────────
  server.registerTool(
    "github_get_issue",
    {
      title: "Get GitHub Issue",
      description: `Fetch a single issue by number from a GitHub repository.

Args:
  - owner (string): Repository owner
  - repo (string): Repository name
  - issue_number (number): Issue number (shown in the URL and issue title)
  - response_format ('markdown'|'json'): Output format (default: 'markdown')

Returns: Full issue details including body, labels, assignees, milestone, and comments count.`,
      inputSchema: ownerRepoSchema.extend({
        issue_number: z.number().int().min(1).describe("Issue number"),
        response_format: responseFormatSchema,
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ owner, repo, issue_number, response_format }) => {
      try {
        const issue = await githubRequest<GithubIssue>("GET", `/repos/${owner}/${repo}/issues/${issue_number}`);
        if (response_format === ResponseFormat.JSON) {
          return { content: [{ type: "text", text: JSON.stringify(issue, null, 2) }], structuredContent: issue };
        }
        return { content: [{ type: "text", text: formatIssue(issue) }], structuredContent: issue };
      } catch (e) {
        return { content: [{ type: "text", text: handleGithubError(e) }] };
      }
    }
  );

  // ── github_create_issue ───────────────────────────────────────────────────
  server.registerTool(
    "github_create_issue",
    {
      title: "Create GitHub Issue",
      description: `Create a new issue in a GitHub repository.

Args:
  - owner (string): Repository owner
  - repo (string): Repository name
  - title (string): Issue title
  - body (string, optional): Issue body in Markdown
  - labels (string[], optional): Array of label names to apply
  - assignees (string[], optional): Array of user logins to assign
  - milestone (number, optional): Milestone number to associate

Returns: Created issue with number and URL.

Error Handling:
  - 403 if you don't have write access to the repo
  - 422 if a label or assignee doesn't exist in the repo`,
      inputSchema: ownerRepoSchema.extend({
        title: z.string().min(1).max(256).describe("Issue title"),
        body: z.string().optional().describe("Issue body in Markdown"),
        labels: z.array(z.string()).optional().describe("Label names to apply"),
        assignees: z.array(z.string()).optional().describe("User logins to assign"),
        milestone: z.number().int().optional().describe("Milestone number"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ owner, repo, title, body, labels, assignees, milestone }) => {
      try {
        const issue = await githubRequest<GithubIssue>("POST", `/repos/${owner}/${repo}/issues`, {
          title,
          body,
          labels,
          assignees,
          milestone,
        });
        return {
          content: [{ type: "text", text: `Issue created: ${issue.html_url}\n\n${formatIssue(issue)}` }],
          structuredContent: issue,
        };
      } catch (e) {
        return { content: [{ type: "text", text: handleGithubError(e) }] };
      }
    }
  );

  // ── github_update_issue ───────────────────────────────────────────────────
  server.registerTool(
    "github_update_issue",
    {
      title: "Update GitHub Issue",
      description: `Update an existing issue: title, body, state, labels, assignees, or milestone.

Args:
  - owner (string): Repository owner
  - repo (string): Repository name
  - issue_number (number): Issue number to update
  - title (string, optional): New title
  - body (string, optional): New body in Markdown
  - state ('open'|'closed'): New state
  - state_reason ('completed'|'not_planned'|'reopened', optional): Reason when closing
  - labels (string[], optional): Replace all labels with this array
  - assignees (string[], optional): Replace all assignees with this array
  - milestone (number|null, optional): Milestone number or null to clear

Returns: Updated issue details.`,
      inputSchema: ownerRepoSchema.extend({
        issue_number: z.number().int().min(1).describe("Issue number"),
        title: z.string().min(1).max(256).optional().describe("New title"),
        body: z.string().optional().describe("New body in Markdown"),
        state: z.enum(["open", "closed"]).optional().describe("New state"),
        state_reason: z.enum(["completed", "not_planned", "reopened"]).optional().describe("Reason for state change"),
        labels: z.array(z.string()).optional().describe("Replacement label list"),
        assignees: z.array(z.string()).optional().describe("Replacement assignee list"),
        milestone: z.number().int().nullable().optional().describe("Milestone number or null to clear"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ owner, repo, issue_number, ...updates }) => {
      try {
        const issue = await githubRequest<GithubIssue>(
          "PATCH",
          `/repos/${owner}/${repo}/issues/${issue_number}`,
          updates
        );
        return {
          content: [{ type: "text", text: `Issue updated: ${issue.html_url}\n\n${formatIssue(issue)}` }],
          structuredContent: issue,
        };
      } catch (e) {
        return { content: [{ type: "text", text: handleGithubError(e) }] };
      }
    }
  );

  // ── github_add_issue_comment ──────────────────────────────────────────────
  server.registerTool(
    "github_add_issue_comment",
    {
      title: "Add Comment to Issue",
      description: `Post a comment on a GitHub issue or pull request.

Args:
  - owner (string): Repository owner
  - repo (string): Repository name
  - issue_number (number): Issue or PR number
  - body (string): Comment text in Markdown

Returns: Created comment with ID and URL.`,
      inputSchema: ownerRepoSchema.extend({
        issue_number: z.number().int().min(1).describe("Issue or PR number"),
        body: z.string().min(1).describe("Comment body in Markdown"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ owner, repo, issue_number, body }) => {
      try {
        const comment = await githubRequest<GithubComment>(
          "POST",
          `/repos/${owner}/${repo}/issues/${issue_number}/comments`,
          { body }
        );
        return {
          content: [{ type: "text", text: `Comment posted: ${comment.html_url}` }],
          structuredContent: comment,
        };
      } catch (e) {
        return { content: [{ type: "text", text: handleGithubError(e) }] };
      }
    }
  );

  // ── github_list_issue_comments ────────────────────────────────────────────
  server.registerTool(
    "github_list_issue_comments",
    {
      title: "List Issue Comments",
      description: `List comments on a GitHub issue or pull request.

Args:
  - owner (string): Repository owner
  - repo (string): Repository name
  - issue_number (number): Issue or PR number
  - page (number): Page number (default: 1)
  - per_page (number): Results per page, max 100 (default: 30)
  - response_format ('markdown'|'json'): Output format (default: 'markdown')

Returns: List of comments with author, body, and timestamps.`,
      inputSchema: ownerRepoSchema
        .extend({
          issue_number: z.number().int().min(1).describe("Issue or PR number"),
          response_format: responseFormatSchema,
        })
        .merge(paginationSchema),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ owner, repo, issue_number, page, per_page, response_format }) => {
      try {
        const comments = await githubRequest<GithubComment[]>(
          "GET",
          `/repos/${owner}/${repo}/issues/${issue_number}/comments`,
          undefined,
          { page, per_page }
        );

        const output = {
          count: comments.length,
          page,
          per_page,
          has_more: comments.length === per_page,
          next_page: comments.length === per_page ? page + 1 : undefined,
          comments: comments.map((c) => ({
            id: c.id,
            user: c.user?.login,
            body: c.body,
            html_url: c.html_url,
            created_at: c.created_at,
            updated_at: c.updated_at,
          })),
        };

        let text: string;
        if (response_format === ResponseFormat.JSON) {
          text = JSON.stringify(output, null, 2);
        } else {
          const lines = [`# Comments on ${owner}/${repo}#${issue_number} (page ${page})`, ""];
          for (const c of comments) {
            lines.push(`### ${c.user?.login ?? "unknown"} — ${c.created_at}`);
            lines.push(c.body ?? "*(empty)*");
            lines.push(`[View](${c.html_url})`, "");
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
}
