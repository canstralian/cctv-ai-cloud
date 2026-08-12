import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { githubRequest, handleGithubError } from "../services/github-client.js";
import { ResponseFormat, type GithubUser, type GithubRelease } from "../types.js";
import { responseFormatSchema, ownerRepoSchema, paginationSchema } from "../schemas/common.js";
import { truncateIfNeeded } from "../services/github-client.js";
import { CHARACTER_LIMIT } from "../constants.js";

export function registerUserTools(server: McpServer): void {
  // ── github_get_authenticated_user ─────────────────────────────────────────
  server.registerTool(
    "github_get_authenticated_user",
    {
      title: "Get Authenticated User",
      description: `Return the profile of the currently authenticated GitHub user (whose GITHUB_TOKEN is in use).

Returns: login, name, email, bio, public_repos, followers, following, created_at, and profile URL.`,
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async () => {
      try {
        const user = await githubRequest<GithubUser>("GET", "/user");
        const text = [
          `# ${user.name ?? user.login} (@${user.login})`,
          user.bio ? `*${user.bio}*` : null,
          `- **Email**: ${user.email ?? "—"}`,
          `- **Public repos**: ${user.public_repos ?? "—"}`,
          `- **Followers**: ${user.followers ?? "—"}  **Following**: ${user.following ?? "—"}`,
          `- **Created**: ${user.created_at ?? "—"}`,
          `- **URL**: ${user.html_url}`,
        ]
          .filter((l) => l !== null)
          .join("\n");
        return { content: [{ type: "text", text }], structuredContent: user };
      } catch (e) {
        return { content: [{ type: "text", text: handleGithubError(e) }] };
      }
    }
  );

  // ── github_get_user ───────────────────────────────────────────────────────
  server.registerTool(
    "github_get_user",
    {
      title: "Get GitHub User or Organization",
      description: `Fetch the public profile of any GitHub user or organization by login.

Args:
  - username (string): GitHub login (user or org)

Returns: Name, bio, location, company, public repo count, followers, and profile URL.`,
      inputSchema: z.object({
        username: z.string().min(1).describe("GitHub login (user or org)"),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ username }) => {
      try {
        const user = await githubRequest<GithubUser & { location?: string; company?: string; blog?: string }>(
          "GET",
          `/users/${username}`
        );
        const text = [
          `# ${user.name ?? user.login} (@${user.login})`,
          user.bio ? `*${user.bio}*` : null,
          user.company ? `- **Company**: ${user.company}` : null,
          user.location ? `- **Location**: ${user.location}` : null,
          user.blog ? `- **Blog**: ${user.blog}` : null,
          `- **Public repos**: ${user.public_repos ?? "—"}`,
          `- **Followers**: ${user.followers ?? "—"}  **Following**: ${user.following ?? "—"}`,
          `- **Created**: ${user.created_at ?? "—"}`,
          `- **URL**: ${user.html_url}`,
        ]
          .filter((l) => l !== null)
          .join("\n");
        return { content: [{ type: "text", text }], structuredContent: user };
      } catch (e) {
        return { content: [{ type: "text", text: handleGithubError(e) }] };
      }
    }
  );

  // ── github_list_releases ──────────────────────────────────────────────────
  server.registerTool(
    "github_list_releases",
    {
      title: "List Repository Releases",
      description: `List releases for a GitHub repository, newest first.

Args:
  - owner (string): Repository owner
  - repo (string): Repository name
  - page (number): Page number (default: 1)
  - per_page (number): Results per page, max 100 (default: 30)
  - response_format ('markdown'|'json'): Output format (default: 'markdown')

Returns: Releases with tag, name, body preview, asset count, and publication date.`,
      inputSchema: ownerRepoSchema
        .extend({ response_format: responseFormatSchema })
        .merge(paginationSchema),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ owner, repo, page, per_page, response_format }) => {
      try {
        const releases = await githubRequest<GithubRelease[]>(
          "GET",
          `/repos/${owner}/${repo}/releases`,
          undefined,
          { page, per_page }
        );

        const output = {
          count: releases.length,
          page,
          per_page,
          has_more: releases.length === per_page,
          next_page: releases.length === per_page ? page + 1 : undefined,
          releases: releases.map((r) => ({
            id: r.id,
            tag_name: r.tag_name,
            name: r.name,
            draft: r.draft,
            prerelease: r.prerelease,
            html_url: r.html_url,
            published_at: r.published_at,
            author: r.author.login,
            asset_count: r.assets.length,
          })),
        };

        let text: string;
        if (response_format === ResponseFormat.JSON) {
          text = JSON.stringify(output, null, 2);
        } else {
          const lines = [`# Releases for ${owner}/${repo} (page ${page})`, ""];
          for (const r of releases) {
            lines.push(`## ${r.tag_name}${r.name ? ` — ${r.name}` : ""}${r.draft ? " [draft]" : ""}${r.prerelease ? " [pre-release]" : ""}`);
            lines.push(`- **Published**: ${r.published_at ?? "—"}  **Author**: ${r.author.login}`);
            lines.push(`- **Assets**: ${r.assets.length}  **URL**: ${r.html_url}`);
            if (r.body) lines.push(`\n${r.body.slice(0, 300)}${r.body.length > 300 ? "\n…" : ""}`);
            lines.push("");
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

  // ── github_get_latest_release ─────────────────────────────────────────────
  server.registerTool(
    "github_get_latest_release",
    {
      title: "Get Latest Release",
      description: `Fetch the latest published (non-draft, non-prerelease) release for a repository.

Args:
  - owner (string): Repository owner
  - repo (string): Repository name

Returns: Tag name, release name, body, assets, and publication date.`,
      inputSchema: ownerRepoSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ owner, repo }) => {
      try {
        const r = await githubRequest<GithubRelease>("GET", `/repos/${owner}/${repo}/releases/latest`);
        const lines = [
          `# Latest Release: ${r.tag_name}${r.name ? ` — ${r.name}` : ""}`,
          `- **Published**: ${r.published_at ?? "—"}  **Author**: ${r.author.login}`,
          `- **URL**: ${r.html_url}`,
          "",
        ];
        if (r.body) lines.push(r.body.slice(0, 1000) + (r.body.length > 1000 ? "\n…" : ""));
        if (r.assets.length) {
          lines.push("\n## Assets");
          for (const a of r.assets) {
            lines.push(`- \`${a.name}\` — ${(a.size / 1024).toFixed(1)} KB — ${a.download_count} downloads`);
          }
        }
        return { content: [{ type: "text", text: lines.join("\n") }], structuredContent: r };
      } catch (e) {
        return { content: [{ type: "text", text: handleGithubError(e) }] };
      }
    }
  );
}
