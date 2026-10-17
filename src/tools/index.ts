import { z } from "zod";
import { loadConfig } from "../config.js";
import { listDir, readFile } from "../fs/ops.js";
import { editFile, writeFile, deleteFile } from "../fs/write.js";
import { runScript } from "../exec/run.js";
import { searchCode } from "../fs/search.js";
import { gitStatus, gitDiff } from "../git/git.js";

export const SERVER_NAME = "local-code-bridge";
export const SERVER_VERSION = "0.1.0";

export const SERVER_INSTRUCTIONS =
  "Local code bridge. Read tools: list_dir, read_file (paged), search, git_status/git_diff. Write tools (edit_file, write_file, delete_file) modify or remove files; every modification/deletion backs up the original to .bridge-backup/ and returns a diff or confirmation. Keep responses small; page large files.";

export interface ToolDef {
  name: string;
  description: string;
  annotations: { readOnlyHint: boolean; destructiveHint: boolean };
  schema: Record<string, unknown>;
  // zod raw shape for McpServer.tool()
  shape: Record<string, z.ZodTypeAny>;
  handler: (args: Record<string, unknown>) => Promise<{ text: string; isError?: boolean }>;
}

function root(): string {
  return loadConfig().allowedRoot;
}

export function toolManifest(): ToolDef[] {
  const mode = loadConfig().mode;
  // Milestone (a): read-only tools always registered.
  const tools: ToolDef[] = [
    {
      name: "list_dir",
      description: "Use this when exploring the project tree. Lists files/dirs under ALLOWED_ROOT.",
      annotations: { readOnlyHint: true, destructiveHint: false },
      schema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Root-relative path, default '.'" },
          depth: { type: "integer", minimum: 1, maximum: 5, default: 2 },
          limit: { type: "integer", minimum: 1, maximum: 1000, default: 200 },
          include_hidden: { type: "boolean", default: false },
        },
      },
      shape: {
        path: z.string().optional().default("."),
        depth: z.number().int().min(1).max(5).optional().default(2),
        limit: z.number().int().min(1).max(1000).optional().default(200),
        include_hidden: z.boolean().optional().default(false),
      },
      handler: async (a) => {
        const { entries, truncated } = listDir(root(), {
          path: String(a.path ?? "."),
          depth: Number(a.depth ?? 2),
          limit: Number(a.limit ?? 200),
          includeHidden: Boolean(a.include_hidden ?? false),
        });
        const lines = entries.map((e) => `${e.type === "dir" ? "DIR " : "FILE"} ${e.path}${e.size !== undefined ? ` (${e.size}b)` : ""}`);
        return { text: lines.join("\n") + (truncated ? "\n[truncated]" : "") };
      },
    },
    {
      name: "read_file",
      description: "Use this when reading source. Supports line ranges; line numbers on by default.",
      annotations: { readOnlyHint: true, destructiveHint: false },
      schema: {
        type: "object",
        required: ["path"],
        properties: {
          path: { type: "string" },
          start_line: { type: "integer", minimum: 1 },
          end_line: { type: "integer", minimum: 1 },
          line_numbers: { type: "boolean", default: true },
        },
      },
      shape: {
        path: z.string(),
        start_line: z.number().int().min(1).optional(),
        end_line: z.number().int().min(1).optional(),
        line_numbers: z.boolean().optional().default(true),
      },
      handler: async (a) => {
        const r = readFile(root(), {
          path: String(a.path),
          startLine: a.start_line !== undefined ? Number(a.start_line) : undefined,
          endLine: a.end_line !== undefined ? Number(a.end_line) : undefined,
          lineNumbers: a.line_numbers !== undefined ? Boolean(a.line_numbers) : true,
        });
        return { text: `# ${r.path} (${r.totalLines} lines, ${r.bytes} bytes${r.truncated ? ", paged" : ""})\n${r.content}` };
      },
    },
    {
      name: "search",
      description: "Use this when finding code. Pure-Node recursive search (no shell). Use glob like *.ts to narrow.",
      annotations: { readOnlyHint: true, destructiveHint: false },
      schema: {
        type: "object",
        required: ["pattern"],
        properties: {
          pattern: { type: "string" },
          path: { type: "string", default: "." },
          glob: { type: "string" },
          regex: { type: "boolean", default: false },
          case_sensitive: { type: "boolean", default: false },
          context_lines: { type: "integer", minimum: 0, maximum: 5, default: 0 },
          max_results: { type: "integer", minimum: 1, maximum: 100, default: 50 },
        },
      },
      shape: {
        pattern: z.string().min(1),
        path: z.string().optional().default("."),
        glob: z.string().optional(),
        regex: z.boolean().optional().default(false),
        case_sensitive: z.boolean().optional().default(false),
        context_lines: z.number().int().min(0).max(5).optional().default(0),
        max_results: z.number().int().min(1).max(100).optional().default(50),
      },
      handler: async (a) => {
        const r = searchCode(root(), {
          pattern: String(a.pattern),
          path: a.path ? String(a.path) : ".",
          glob: a.glob ? String(a.glob) : undefined,
          regex: Boolean(a.regex ?? false),
          caseSensitive: Boolean(a.case_sensitive ?? false),
          contextLines: Number(a.context_lines ?? 0),
          maxResults: Number(a.max_results ?? 50),
        });
        if (!r.hits.length) return { text: "no matches" };
        const lines = r.hits.map((h) => `${h.path}:${h.line}: ${h.text}`);
        return { text: lines.join("\n") + (r.truncated ? "\n[truncated]" : "") + `\n(scanned ${r.scanned} files)` };
      },
    },
    {
      name: "git_status",
      description: "Use this when checking working tree status. Read-only git status.",
      annotations: { readOnlyHint: true, destructiveHint: false },
      schema: { type: "object", properties: { path: { type: "string", default: "." } } },
      shape: { path: z.string().optional().default(".") },
      handler: async (a) => {
        const r = await gitStatus(root(), String(a.path ?? "."));
        return { text: r.output || "(clean)" };
      },
    },
    {
      name: "git_diff",
      description: "Use this when reviewing changes. Read-only git diff with stat option.",
      annotations: { readOnlyHint: true, destructiveHint: false },
      schema: {
        type: "object",
        properties: {
          path: { type: "string", default: "." },
          staged: { type: "boolean", default: false },
          stat_only: { type: "boolean", default: false },
          context_lines: { type: "integer", minimum: 0, maximum: 10, default: 3 },
        },
      },
      shape: {
        path: z.string().optional().default("."),
        staged: z.boolean().optional().default(false),
        stat_only: z.boolean().optional().default(false),
        context_lines: z.number().int().min(0).max(10).optional().default(3),
      },
      handler: async (a) => {
        const r = await gitDiff(root(), {
          path: String(a.path ?? "."),
          staged: Boolean(a.staged ?? false),
          statOnly: Boolean(a.stat_only ?? false),
          contextLines: Number(a.context_lines ?? 3),
        });
        return { text: r.output || "(no diff)" };
      },
    },
  ];

  // MODE gating: read-only tools are always available.
  // Write tools register only in edit/exec modes. In read mode they are absent
  // entirely, so no client can invoke them.
  if (mode === "edit" || mode === "exec") {
    tools.push(
      {
        name: "edit_file",
        description: "Use this when modifying a file. Replaces ONE exact string occurrence; backs up the original and returns a diff. Fails if old_string is missing or matches multiple times.",
        annotations: { readOnlyHint: false, destructiveHint: true },
        schema: {
          type: "object",
          required: ["path", "old_string", "new_string"],
          properties: {
            path: { type: "string" },
            old_string: { type: "string" },
            new_string: { type: "string" },
          },
        },
        shape: {
          path: z.string(),
          old_string: z.string().min(1),
          new_string: z.string(),
        },
        handler: async (a) => {
          if (loadConfig().mode === "read") throw new Error("write tools are disabled in read mode");
          const r = editFile(root(), {
            path: String(a.path),
            oldString: String(a.old_string),
            newString: String(a.new_string ?? ""),
          });
          return { text: `edited. backup: ${r.backup}\n${r.diff}` };
        },
      },
      {
        name: "write_file",
        description: "Use this when creating a file or replacing whole content. Backs up the existing file (if any) and returns a diff. Parent dirs are created inside the root.",
        annotations: { readOnlyHint: false, destructiveHint: true },
        schema: {
          type: "object",
          required: ["path", "content"],
          properties: {
            path: { type: "string" },
            content: { type: "string" },
          },
        },
        shape: {
          path: z.string(),
          content: z.string(),
        },
        handler: async (a) => {
          if (loadConfig().mode === "read") throw new Error("write tools are disabled in read mode");
          const r = writeFile(root(), { path: String(a.path), content: String(a.content ?? "") });
          const b = r.backup ? `backup: ${r.backup}\n` : "";
          return { text: `${r.created ? "created" : "overwritten"}. ${b}${r.diff}` };
        },
      },
      {
        name: "delete_file",
        description: "Use this when deleting a file. Always backs up the file to .bridge-backup/ before unlinking. Refuses directories, root, or missing files.",
        annotations: { readOnlyHint: false, destructiveHint: true },
        schema: {
          type: "object",
          required: ["path"],
          properties: {
            path: { type: "string", description: "Root-relative file path to delete" },
          },
        },
        shape: {
          path: z.string().min(1),
        },
        handler: async (a) => {
          if (loadConfig().mode === "read") throw new Error("write tools are disabled in read mode");
          const r = deleteFile(root(), String(a.path));
          return { text: `deleted ${r.path}. backup saved to: ${r.backup}` };
        },
      },
    );
  }

  // Milestone (e): run_script registers ONLY in exec mode. It runs a NAMED script
  // from SCRIPTS_JSON with fixed argv — no custom commands, no extra args, no shell.
  if (mode === "exec") {
    tools.push({
      name: "run_script",
      description: "Use this when running a project script. Only named scripts from server config (e.g. check, test). No custom commands or arguments. Runs with cwd inside the root, 60s timeout, capped output.",
      annotations: { readOnlyHint: false, destructiveHint: true },
      schema: {
        type: "object",
        required: ["name"],
        properties: {
          name: { type: "string", description: "Configured script name" },
          path: { type: "string", description: "Root-relative working dir, default '.'" },
        },
      },
      shape: {
        name: z.string().min(1),
        path: z.string().optional().default("."),
      },
      handler: async (a) => {
        const cfg = loadConfig();
        if (cfg.mode !== "exec") throw new Error("run_script is disabled unless MODE=exec");
        const r = await runScript(root(), cfg.scripts, String(a.name), String(a.path ?? "."));
        const head = `exit=${r.exitCode ?? "?"}${r.timedOut ? " (timed out)" : ""}${r.truncated ? " (truncated)" : ""}`;
        return { text: r.output ? `${head}\n${r.output}` : `${head}\n(no output)` };
      },
    });
  }
  return tools;
}
