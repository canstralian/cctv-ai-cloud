import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { githubRequest, handleGithubError } from "../services/github-client.js";
import { ownerRepoSchema, paginationSchema } from "../schemas/common.js";
import type { GithubBranch } from "../types.js";

export function registerBranchTools(server: McpServer): void {
  // ── github_list_branches ──────────────────────────────────────────────────
  server.registerTool(
    "github_list_branches",
    {
      title: "List Repository Branches",
      description: `List branches in a GitHub repository.

Args:
  - owner (string): Repository owner
  - repo (string): Repository name
  - protected (boolean, optional): Filter to only protected branches
  - page (number): Page number (default: 1)
  - per_page (number): Results per page, max 100 (default: 30)

Returns: List of branch names, their HEAD commit SHA, and protection status.`,
      inputSchema: ownerRepoSchema
        .extend({ protected: z.boolean().optional().describe("Only return protected branches") })
        .merge(paginationSchema),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ owner, repo, protected: prot, page, per_page }) => {
      try {
        const branches = await githubRequest<GithubBranch[]>(
          "GET",
          `/repos/${owner}/${repo}/branches`,
          undefined,
          { protected: prot, page, per_page }
        );

        const output = {
          count: branches.length,
          page,
          per_page,
          has_more: branches.length === per_page,
          next_page: branches.length === per_page ? page + 1 : undefined,
          branches: branches.map((b) => ({
            name: b.name,
            sha: b.commit.sha,
            protected: b.protected,
          })),
        };

        const lines = [`# Branches in ${owner}/${repo} (page ${page})`, ""];
        for (const b of branches) {
          lines.push(`- \`${b.name}\` — ${b.commit.sha.slice(0, 7)}${b.protected ? " 🔒" : ""}`);
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

  // ── github_get_branch ─────────────────────────────────────────────────────
  server.registerTool(
    "github_get_branch",
    {
      title: "Get Branch",
      description: `Get details for a specific branch including its HEAD commit and protection rules.

Args:
  - owner (string): Repository owner
  - repo (string): Repository name
  - branch (string): Branch name`,
      inputSchema: ownerRepoSchema.extend({ branch: z.string().min(1).describe("Branch name") }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ owner, repo, branch }) => {
      try {
        const data = await githubRequest<GithubBranch & { _links?: unknown }>(
          "GET",
          `/repos/${owner}/${repo}/branches/${branch}`
        );

        const output = { name: data.name, sha: data.commit.sha, protected: data.protected };

        return {
          content: [
            {
              type: "text",
              text: `# Branch: ${data.name}\n- **SHA**: ${data.commit.sha}\n- **Protected**: ${data.protected}`,
            },
          ],
          structuredContent: output,
        };
      } catch (e) {
        return { content: [{ type: "text", text: handleGithubError(e) }] };
      }
    }
  );

  // ── github_create_branch ──────────────────────────────────────────────────
  server.registerTool(
    "github_create_branch",
    {
      title: "Create Branch",
      description: `Create a new branch in a GitHub repository from a SHA or existing branch.

Args:
  - owner (string): Repository owner
  - repo (string): Repository name
  - branch (string): Name for the new branch
  - sha (string): SHA to branch from (get from github_get_branch or github_list_commits)

Returns: Created reference with full ref name and SHA.`,
      inputSchema: ownerRepoSchema.extend({
        branch: z.string().min(1).describe("New branch name"),
        sha: z.string().min(7).describe("Commit SHA to branch from"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ owner, repo, branch, sha }) => {
      try {
        const ref = `refs/heads/${branch}`;
        const result = await githubRequest<{ ref: string; object: { sha: string } }>(
          "POST",
          `/repos/${owner}/${repo}/git/refs`,
          { ref, sha }
        );

        return {
          content: [{ type: "text", text: `Branch created: ${branch}\nRef: ${result.ref}\nSHA: ${result.object.sha}` }],
          structuredContent: { branch, ref: result.ref, sha: result.object.sha },
        };
      } catch (e) {
        return { content: [{ type: "text", text: handleGithubError(e) }] };
      }
    }
  );

  // ── github_delete_branch ──────────────────────────────────────────────────
  server.registerTool(
    "github_delete_branch",
    {
      title: "Delete Branch",
      description: `Delete a branch from a GitHub repository. This is a destructive operation — the branch cannot be recovered unless you know its SHA.

Args:
  - owner (string): Repository owner
  - repo (string): Repository name
  - branch (string): Branch name to delete

Error Handling:
  - 422 if the branch is the repo's default branch (protected from deletion via this endpoint)`,
      inputSchema: ownerRepoSchema.extend({ branch: z.string().min(1).describe("Branch name to delete") }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ owner, repo, branch }) => {
      try {
        await githubRequest("DELETE", `/repos/${owner}/${repo}/git/refs/heads/${branch}`);
        return {
          content: [{ type: "text", text: `Branch deleted: ${branch} in ${owner}/${repo}` }],
          structuredContent: { deleted: true, branch },
        };
      } catch (e) {
        return { content: [{ type: "text", text: handleGithubError(e) }] };
      }
    }
  );
}
