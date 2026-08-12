import { z } from "zod";
import { ResponseFormat } from "../types.js";

export const responseFormatSchema = z
  .nativeEnum(ResponseFormat)
  .default(ResponseFormat.MARKDOWN)
  .describe("Output format: 'markdown' for human-readable or 'json' for machine-readable");

export const paginationSchema = z.object({
  page: z.number().int().min(1).default(1).describe("Page number (1-indexed)"),
  per_page: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(30)
    .describe("Number of results per page (max 100)"),
});

export const ownerRepoSchema = z.object({
  owner: z.string().min(1).describe("GitHub username or organization name"),
  repo: z.string().min(1).describe("Repository name (without owner prefix)"),
});
