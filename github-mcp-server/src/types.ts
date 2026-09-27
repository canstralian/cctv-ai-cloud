export enum ResponseFormat {
  MARKDOWN = "markdown",
  JSON = "json",
}

export interface PaginationMeta {
  [key: string]: unknown;
  total_count?: number;
  count: number;
  page: number;
  per_page: number;
  has_more: boolean;
  next_page?: number;
}

export interface GithubUser {
  [key: string]: unknown;
  login: string;
  id: number;
  html_url: string;
  avatar_url?: string;
  name?: string;
  email?: string;
  bio?: string;
  public_repos?: number;
  followers?: number;
  following?: number;
  created_at?: string;
}

export interface GithubRepo {
  [key: string]: unknown;
  id: number;
  name: string;
  full_name: string;
  html_url: string;
  description: string | null;
  private: boolean;
  fork: boolean;
  default_branch: string;
  stargazers_count: number;
  forks_count: number;
  open_issues_count: number;
  language: string | null;
  topics?: string[];
  created_at: string;
  updated_at: string;
  pushed_at: string;
  owner: { login: string; html_url: string };
}

export interface GithubIssue {
  [key: string]: unknown;
  id: number;
  number: number;
  title: string;
  state: string;
  html_url: string;
  body: string | null;
  user: { login: string } | null;
  assignees: { login: string }[];
  labels: { name: string; color: string }[];
  milestone: { title: string; number: number } | null;
  comments: number;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  pull_request?: unknown;
}

export interface GithubPR {
  [key: string]: unknown;
  id: number;
  number: number;
  title: string;
  state: string;
  html_url: string;
  body: string | null;
  user: { login: string } | null;
  head: { ref: string; sha: string; repo: { full_name: string } | null };
  base: { ref: string; sha: string; repo: { full_name: string } | null };
  assignees: { login: string }[];
  requested_reviewers: { login: string }[];
  labels: { name: string }[];
  draft: boolean;
  merged: boolean;
  mergeable?: boolean | null;
  merge_commit_sha: string | null;
  commits: number;
  additions: number;
  deletions: number;
  changed_files: number;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  merged_at: string | null;
}

export interface GithubComment {
  [key: string]: unknown;
  id: number;
  body: string;
  user: { login: string } | null;
  html_url: string;
  created_at: string;
  updated_at: string;
}

export interface GithubBranch {
  [key: string]: unknown;
  name: string;
  commit: { sha: string; url: string };
  protected: boolean;
}

export interface GithubCommit {
  [key: string]: unknown;
  sha: string;
  html_url: string;
  commit: {
    message: string;
    author: { name: string; email: string; date: string } | null;
    committer: { name: string; email: string; date: string } | null;
  };
  author: { login: string } | null;
  committer: { login: string } | null;
  stats?: { additions: number; deletions: number; total: number };
  files?: { filename: string; status: string; additions: number; deletions: number }[];
}

export interface GithubWorkflowRun {
  [key: string]: unknown;
  id: number;
  name: string;
  head_branch: string;
  head_sha: string;
  status: string;
  conclusion: string | null;
  html_url: string;
  created_at: string;
  updated_at: string;
  run_number: number;
  workflow_id: number;
  event: string;
}

export interface GithubRelease {
  [key: string]: unknown;
  id: number;
  tag_name: string;
  name: string | null;
  body: string | null;
  draft: boolean;
  prerelease: boolean;
  html_url: string;
  created_at: string;
  published_at: string | null;
  author: { login: string };
  assets: { name: string; size: number; download_count: number }[];
}
