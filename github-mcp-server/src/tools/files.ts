import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { githubRequest, handleGithubError } from "../services/github-client.js";
import { ownerRepoSchema } from "../schemas/common.js";

interface FileContent {
  name: string;
  path: string;
  sha: string;
  size: number;
  type: "file" | "dir" | "symlink";
  content?: string;
  encoding?: string;
  html_url: string;
  download_url: string | null;
}

interface CommitResponse {
  commit: { sha: string; html_url: string; message: string };
  content: FileContent | null;
}

export function registerFileTools(server: McpServer): void {
  // ── github_get_file_contents ──────────────────────────────────────────────
  server.registerTool(
    "github_get_file_contents",
    {
      title: "Get File or Directory Contents",
      description: `Fetch the contents of a file or directory in a GitHub repository.

For files: returns decoded text content (base64-decoded) plus metadata.
For directories: returns a listing of contained items.

Args:
  - owner (string): Repository owner
  - repo (string): Repository name
  - path (string): Path to file or directory (e.g. 'src/index.ts' or 'src/')
  - ref (string, optional): Branch, tag, or commit SHA (defaults to repo default branch)

Returns:
  For files: { name, path, sha, size, content (decoded text), html_url }
  For directories: array of { name, path, type, size, sha, html_url }

Error Handling:
  - 404 if the path doesn't exist on the specified ref`,
      inputSchema: ownerRepoSchema.extend({
        path: z.string().min(1).describe("File or directory path in the repo"),
        ref: z.string().optional().describe("Branch, tag, or commit SHA (default: repo default branch)"),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ owner, repo, path, ref }) => {
      try {
        const data = await githubRequest<FileContent | FileContent[]>(
          "GET",
          `/repos/${owner}/${repo}/contents/${path}`,
          undefined,
          ref ? { ref } : undefined
        );

        if (Array.isArray(data)) {
          // Directory listing
          const output = {
            type: "directory",
            path,
            items: data.map((item) => ({
              name: item.name,
              path: item.path,
              type: item.type,
              size: item.size,
              sha: item.sha,
              html_url: item.html_url,
            })),
          };
          const lines = [`# Directory: ${path}`, ""];
          for (const item of data) {
            const icon = item.type === "dir" ? "📁" : "📄";
            lines.push(`${icon} \`${item.name}\` — ${item.type}${item.type === "file" ? ` (${item.size} bytes)` : ""}`);
          }
          return {
            content: [{ type: "text", text: lines.join("\n") }],
            structuredContent: output,
          };
        }

        // Single file
        let decodedContent = "";
        if (data.content && data.encoding === "base64") {
          decodedContent = Buffer.from(data.content.replace(/\n/g, ""), "base64").toString("utf-8");
        }

        const output = {
          name: data.name,
          path: data.path,
          sha: data.sha,
          size: data.size,
          html_url: data.html_url,
          download_url: data.download_url,
          content: decodedContent,
        };

        const text = [
          `# File: ${data.path}`,
          `SHA: ${data.sha}  Size: ${data.size} bytes`,
          `URL: ${data.html_url}`,
          "",
          "```",
          decodedContent.slice(0, 20000) + (decodedContent.length > 20000 ? "\n...[truncated]" : ""),
          "```",
        ].join("\n");

        return { content: [{ type: "text", text }], structuredContent: output };
      } catch (e) {
        return { content: [{ type: "text", text: handleGithubError(e) }] };
      }
    }
  );

  // ── github_create_or_update_file ──────────────────────────────────────────
  server.registerTool(
    "github_create_or_update_file",
    {
      title: "Create or Update File",
      description: `Create a new file or update an existing file in a GitHub repository.

To UPDATE an existing file, you MUST provide the current file's SHA (get it from github_get_file_contents first).
To CREATE a new file, omit the sha parameter.

Args:
  - owner (string): Repository owner
  - repo (string): Repository name
  - path (string): File path in the repo (e.g. 'docs/guide.md')
  - message (string): Commit message
  - content (string): File content as plain text (will be base64-encoded automatically)
  - sha (string, optional): Current file SHA — required when updating an existing file
  - branch (string, optional): Branch to commit to (defaults to repo default branch)
  - author_name (string, optional): Commit author name
  - author_email (string, optional): Commit author email

Returns: Commit SHA, URL, and the updated file's new SHA.`,
      inputSchema: ownerRepoSchema.extend({
        path: z.string().min(1).describe("File path in the repo"),
        message: z.string().min(1).describe("Commit message"),
        content: z.string().describe("File content (plain text, not base64)"),
        sha: z.string().optional().describe("Current file SHA (required for updates)"),
        branch: z.string().optional().describe("Target branch (default: repo default branch)"),
        author_name: z.string().optional().describe("Commit author name"),
        author_email: z.string().optional().describe("Commit author email"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ owner, repo, path, message, content, sha, branch, author_name, author_email }) => {
      try {
        const encoded = Buffer.from(content, "utf-8").toString("base64");
        const body: Record<string, unknown> = { message, content: encoded };
        if (sha) body.sha = sha;
        if (branch) body.branch = branch;
        if (author_name && author_email) body.author = { name: author_name, email: author_email };

        const result = await githubRequest<CommitResponse>(
          "PUT",
          `/repos/${owner}/${repo}/contents/${path}`,
          body
        );

        return {
          content: [
            {
              type: "text",
              text: `File ${sha ? "updated" : "created"}: ${result.commit.html_url}\nCommit: ${result.commit.sha}`,
            },
          ],
          structuredContent: {
            commit_sha: result.commit.sha,
            commit_url: result.commit.html_url,
            file_sha: result.content?.sha,
            path,
          },
        };
      } catch (e) {
        return { content: [{ type: "text", text: handleGithubError(e) }] };
      }
    }
  );

  // ── github_delete_file ────────────────────────────────────────────────────
  server.registerTool(
    "github_delete_file",
    {
      title: "Delete File",
      description: `Delete a file from a GitHub repository. The current file SHA is required to prevent accidental overwrites.

Args:
  - owner (string): Repository owner
  - repo (string): Repository name
  - path (string): File path to delete
  - message (string): Commit message
  - sha (string): Current file SHA (get from github_get_file_contents)
  - branch (string, optional): Branch to delete from (defaults to repo default branch)

Returns: Commit SHA and URL confirming the deletion.`,
      inputSchema: ownerRepoSchema.extend({
        path: z.string().min(1).describe("File path to delete"),
        message: z.string().min(1).describe("Commit message"),
        sha: z.string().min(1).describe("Current file SHA (required)"),
        branch: z.string().optional().describe("Branch to commit to (default: repo default branch)"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ owner, repo, path, message, sha, branch }) => {
      try {
        const body: Record<string, unknown> = { message, sha };
        if (branch) body.branch = branch;

        const result = await githubRequest<{ commit: { sha: string; html_url: string } }>(
          "DELETE",
          `/repos/${owner}/${repo}/contents/${path}`,
          body
        );

        return {
          content: [{ type: "text", text: `File deleted: ${path}\nCommit: ${result.commit.sha}\n${result.commit.html_url}` }],
          structuredContent: { commit_sha: result.commit.sha, commit_url: result.commit.html_url, path },
        };
      } catch (e) {
        return { content: [{ type: "text", text: handleGithubError(e) }] };
      }
    }
  );
}
