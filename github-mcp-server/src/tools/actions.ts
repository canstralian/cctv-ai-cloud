import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { githubRequest, handleGithubError, truncateIfNeeded } from "../services/github-client.js";
import { ownerRepoSchema, paginationSchema, responseFormatSchema } from "../schemas/common.js";
import { ResponseFormat, type GithubWorkflowRun } from "../types.js";
import { CHARACTER_LIMIT } from "../constants.js";

interface Workflow {
  id: number;
  name: string;
  path: string;
  state: string;
  html_url: string;
  created_at: string;
  updated_at: string;
}

function formatRun(r: GithubWorkflowRun): string {
  return [
    `### Run #${r.run_number} — ${r.name}`,
    `- **Status**: ${r.status}  **Conclusion**: ${r.conclusion ?? "pending"}`,
    `- **Branch**: ${r.head_branch}  **Event**: ${r.event}`,
    `- **SHA**: ${r.head_sha.slice(0, 7)}`,
    `- **Created**: ${r.created_at}  **Updated**: ${r.updated_at}`,
    `- **URL**: ${r.html_url}`,
    "",
  ].join("\n");
}

export function registerActionsTools(server: McpServer): void {
  // ── github_list_workflows ─────────────────────────────────────────────────
  server.registerTool(
    "github_list_workflows",
    {
      title: "List Repository Workflows",
      description: `List GitHub Actions workflows defined in a repository.

Args:
  - owner (string): Repository owner
  - repo (string): Repository name
  - page (number): Page number (default: 1)
  - per_page (number): Results per page, max 100 (default: 30)

Returns: Workflow names, paths, states, and IDs.`,
      inputSchema: ownerRepoSchema.merge(paginationSchema),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ owner, repo, page, per_page }) => {
      try {
        const data = await githubRequest<{ total_count: number; workflows: Workflow[] }>(
          "GET",
          `/repos/${owner}/${repo}/actions/workflows`,
          undefined,
          { page, per_page }
        );

        const output = {
          total_count: data.total_count,
          count: data.workflows.length,
          workflows: data.workflows.map((w) => ({
            id: w.id,
            name: w.name,
            path: w.path,
            state: w.state,
            html_url: w.html_url,
          })),
        };

        const lines = [`# Workflows in ${owner}/${repo}`, ""];
        for (const w of data.workflows) {
          lines.push(`## ${w.name} (id: ${w.id})`);
          lines.push(`- **Path**: \`${w.path}\``);
          lines.push(`- **State**: ${w.state}`);
          lines.push(`- **URL**: ${w.html_url}`, "");
        }

        return {
          content: [{ type: "text", text: lines.join("\n") }],
          structuredContent: output,
        };
      } catch (e) {
        return { content: [{ type: "text", text: handleGithubError(e) }] };
      }
    }
  );

  // ── github_list_workflow_runs ─────────────────────────────────────────────
  server.registerTool(
    "github_list_workflow_runs",
    {
      title: "List Workflow Runs",
      description: `List runs for a specific workflow or all workflow runs for a repository.

Args:
  - owner (string): Repository owner
  - repo (string): Repository name
  - workflow_id (string|number, optional): Workflow ID or filename (e.g. 'ci.yml'). Omit to list all runs.
  - branch (string, optional): Filter by branch name
  - event (string, optional): Filter by trigger event (e.g. 'push', 'pull_request', 'schedule')
  - status ('queued'|'in_progress'|'completed'|'waiting'|'requested'|'pending'|'action_required'|'cancelled'|'failure'|'neutral'|'skipped'|'stale'|'success'|'timed_out'|'startup_failure', optional): Filter by status/conclusion
  - page (number): Page number (default: 1)
  - per_page (number): Results per page, max 100 (default: 30)
  - response_format ('markdown'|'json'): Output format (default: 'markdown')

Returns: Workflow runs with status, conclusion, branch, event, and URL.`,
      inputSchema: ownerRepoSchema
        .extend({
          workflow_id: z.union([z.string(), z.number()]).optional().describe("Workflow ID or filename"),
          branch: z.string().optional().describe("Filter by branch name"),
          event: z.string().optional().describe("Trigger event (push, pull_request, schedule, etc.)"),
          status: z
            .enum(["queued", "in_progress", "completed", "waiting", "requested", "pending", "action_required", "cancelled", "failure", "neutral", "skipped", "stale", "success", "timed_out", "startup_failure"])
            .optional()
            .describe("Filter by status or conclusion"),
          response_format: responseFormatSchema,
        })
        .merge(paginationSchema),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ owner, repo, workflow_id, branch, event, status, page, per_page, response_format }) => {
      try {
        const endpoint = workflow_id
          ? `/repos/${owner}/${repo}/actions/workflows/${workflow_id}/runs`
          : `/repos/${owner}/${repo}/actions/runs`;

        const data = await githubRequest<{ total_count: number; workflow_runs: GithubWorkflowRun[] }>(
          "GET",
          endpoint,
          undefined,
          { branch, event, status, page, per_page }
        );

        const output = {
          total_count: data.total_count,
          count: data.workflow_runs.length,
          page,
          per_page,
          has_more: data.total_count > page * per_page,
          next_page: data.total_count > page * per_page ? page + 1 : undefined,
          runs: data.workflow_runs.map((r) => ({
            id: r.id,
            run_number: r.run_number,
            name: r.name,
            status: r.status,
            conclusion: r.conclusion,
            branch: r.head_branch,
            event: r.event,
            sha: r.head_sha.slice(0, 7),
            created_at: r.created_at,
            html_url: r.html_url,
          })),
        };

        let text: string;
        if (response_format === ResponseFormat.JSON) {
          text = JSON.stringify(output, null, 2);
        } else {
          const lines = [`# Workflow Runs for ${owner}/${repo} (page ${page})`, `*${data.total_count} total*`, ""];
          for (const r of data.workflow_runs) lines.push(formatRun(r));
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

  // ── github_get_workflow_run ───────────────────────────────────────────────
  server.registerTool(
    "github_get_workflow_run",
    {
      title: "Get Workflow Run",
      description: `Fetch full details for a single workflow run by its ID.

Args:
  - owner (string): Repository owner
  - repo (string): Repository name
  - run_id (number): Workflow run ID (from github_list_workflow_runs)

Returns: Run status, conclusion, timing, triggering commit, and URL.`,
      inputSchema: ownerRepoSchema.extend({
        run_id: z.number().int().min(1).describe("Workflow run ID"),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ owner, repo, run_id }) => {
      try {
        const r = await githubRequest<GithubWorkflowRun>("GET", `/repos/${owner}/${repo}/actions/runs/${run_id}`);
        return {
          content: [{ type: "text", text: formatRun(r) }],
          structuredContent: r,
        };
      } catch (e) {
        return { content: [{ type: "text", text: handleGithubError(e) }] };
      }
    }
  );

  // ── github_trigger_workflow ───────────────────────────────────────────────
  server.registerTool(
    "github_trigger_workflow",
    {
      title: "Trigger Workflow Dispatch",
      description: `Manually trigger a workflow that has a workflow_dispatch event trigger.

Args:
  - owner (string): Repository owner
  - repo (string): Repository name
  - workflow_id (string|number): Workflow ID or filename (e.g. 'deploy.yml')
  - ref (string): Branch or tag to run the workflow on
  - inputs (object, optional): Key-value pairs for workflow inputs defined in the workflow file

Returns: 204 No Content on success (use github_list_workflow_runs to check the triggered run).

Error Handling:
  - 422 if the workflow doesn't have a workflow_dispatch trigger or the ref doesn't exist`,
      inputSchema: ownerRepoSchema.extend({
        workflow_id: z.union([z.string(), z.number()]).describe("Workflow ID or filename"),
        ref: z.string().min(1).describe("Branch or tag to run on"),
        inputs: z.record(z.string()).optional().describe("Workflow input key-value pairs"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ owner, repo, workflow_id, ref, inputs }) => {
      try {
        await githubRequest(
          "POST",
          `/repos/${owner}/${repo}/actions/workflows/${workflow_id}/dispatches`,
          { ref, inputs }
        );
        return {
          content: [
            {
              type: "text",
              text: `Workflow dispatched on ref '${ref}'. Use github_list_workflow_runs to monitor the run.`,
            },
          ],
          structuredContent: { dispatched: true, workflow_id, ref },
        };
      } catch (e) {
        return { content: [{ type: "text", text: handleGithubError(e) }] };
      }
    }
  );
}
