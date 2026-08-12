import axios, { AxiosError, type AxiosInstance } from "axios";
import { GITHUB_API_BASE } from "../constants.js";

let client: AxiosInstance | null = null;

export function getGithubClient(): AxiosInstance {
  if (client) return client;

  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error("GITHUB_TOKEN environment variable is required");
  }

  client = axios.create({
    baseURL: GITHUB_API_BASE,
    timeout: 30000,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
  });

  return client;
}

export async function githubRequest<T>(
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  data?: unknown,
  params?: Record<string, unknown>
): Promise<T> {
  const gh = getGithubClient();
  const response = await gh.request<T>({ method, url: path, data, params });
  return response.data;
}

export function handleGithubError(error: unknown): string {
  if (error instanceof AxiosError) {
    const status = error.response?.status;
    const message = (error.response?.data as { message?: string })?.message;

    switch (status) {
      case 401:
        return "Error: Authentication failed. Check that GITHUB_TOKEN is valid and not expired.";
      case 403:
        return `Error: Permission denied. ${message ?? "Your token may lack required scopes (e.g. repo, read:org)."}`;
      case 404:
        return `Error: Not found. ${message ?? "Check the owner, repo name, or resource ID."}`;
      case 409:
        return `Error: Conflict. ${message ?? "The resource already exists or there is a merge conflict."}`;
      case 422:
        return `Error: Validation failed. ${message ?? "Check the request parameters."}`;
      case 429:
        return "Error: Rate limit exceeded. Wait before making more requests (check X-RateLimit-Reset header).";
      default:
        return `Error: GitHub API returned status ${status ?? "unknown"}. ${message ?? error.message}`;
    }
  }
  return `Error: ${error instanceof Error ? error.message : String(error)}`;
}

export function truncateIfNeeded(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const half = Math.floor(limit / 2);
  return (
    text.slice(0, half) +
    `\n\n[...response truncated (${text.length} chars). Use filters or pagination to narrow results...]\n\n` +
    text.slice(text.length - half)
  );
}
