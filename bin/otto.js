#!/usr/bin/env node
import { Command } from "commander";
import OpenAI from "openai";
import {
  intro,
  outro,
  spinner,
  select,
  confirm,
  text,
  isCancel,
  note,
  group,
} from "@clack/prompts";
import pc from "picocolors";
import { execSync } from "child_process";
import dotenv from "dotenv";

dotenv.config();

// --- Configuration ---
const SHEET_WEBHOOK_URL = process.env.GOOGLE_SHEET_WEBHOOK_URL;

// --- Core Utilities ---
const sh = (cmd, ignore = false) => {
  try {
    return execSync(cmd, { stdio: "pipe" }).toString().trim();
  } catch (e) {
    if (!ignore) throw new Error(e?.stderr?.toString() || e?.message || String(e));
    return "";
  }
};

const wrap = (s, w = 60) => {
  if (!s) return "";
  return s
    .split(/\s+/)
    .reduce((acc, word) => {
      const last = acc[acc.length - 1];
      if (last && (last + word).length < w) acc[acc.length - 1] += " " + word;
      else acc.push(word);
      return acc;
    }, [])
    .join("\n");
};

// --- Git Helpers (safe outside repos) ---
const git = {
  isRepo: () => sh("git rev-parse --is-inside-work-tree", true) === "true",

  branch: () => {
    if (!git.isRepo()) return "no-git";

    // Normal branch (works even when HEAD is "unborn" if symbolic-ref returns nothing)
    const b = sh("git symbolic-ref --short -q HEAD", true);
    if (b) return b;

    // Detached HEAD fallback
    const d = sh("git rev-parse --short HEAD", true);
    return d ? `detached@${d}` : "unborn";
  },

  user: () => sh("git config user.name", true) || "Ghost",

  diff: (staged = true) =>
    sh(`git diff ${staged ? "--cached" : ""} --stat`, true),

  rawDiff: () => sh("git diff --cached", true),

  // Silent Auto-Stash
  stash: () => {
    if (!git.isRepo()) return false;
    const isDirty = sh("git status --porcelain", true).length > 0;
    if (!isDirty) return false;
    sh('git stash push -m "Otto Auto-Switch"', true);
    return true;
  },

  // Safe Pop
  pop: () => {
    if (!git.isRepo()) return false;
    try {
      sh("git stash pop");
      return true;
    } catch {
      return false; // Conflict during pop
    }
  },
};

const ui = {
  die: (msg) => {
    outro(pc.red(msg));
    process.exit(1);
  },
  banner: () => {
    console.clear();
    intro(pc.bgCyan(pc.black(" Otto by @thev1ndu ")));

    const user = git.user();
    const br = git.branch();
    console.log(pc.dim(`👋 Hello, ${user} (on ${pc.cyan(br)})`));

    if (!git.isRepo()) {
      note(
        "You're not inside a git repository. 'release' and 'branch' commands need a repo.",
        "ℹ Git"
      );
    }
  },
};

// --- Services ---
async function logToSheet(data) {
  if (!SHEET_WEBHOOK_URL) return;
  try {
    await fetch(SHEET_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
  } catch {
    // ignore
  }
}

async function generateCommit(diff) {
  if (!process.env.OPENAI_API_KEY) ui.die("Missing OPENAI_API_KEY");

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const s = spinner();
  s.start(pc.magenta("🤖 AI Analyzing changes"));

  try {
    const res = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "user",
          content:
            `Analyze diff, return JSON with "msg" (conventional commit) and "desc" (technical summary):\n` +
            diff.substring(0, 15000),
        },
      ],
      response_format: { type: "json_object" },
    });

    s.stop(pc.green("✔ AI Analysis Complete"));
    return JSON.parse(res.choices?.[0]?.message?.content || "{}");
  } catch (e) {
    s.stop(pc.red("✖ AI Failed"));
    throw e;
  }
}

// --- Flows ---
async function flowRelease() {
  if (!git.isRepo()) ui.die("Not a git repository. Run `otto` inside a repo.");

  const config = await group(
    {
      type: () =>
        select({
          message: "Release Type",
          options: [
            { value: "patch", label: "🐛 Patch", hint: "Fixes" },
            { value: "minor", label: "✨ Minor", hint: "Features" },
            { value: "major", label: "💥 Major", hint: "Breaking" },
            { value: "none", label: "💨 Snapshot", hint: "No version bump" },
          ],
        }),
      push: () =>
        select({
          message: "Push Mode",
          options: [
            { value: "safe", label: "🛡️ Safe", hint: "Standard push" },
            { value: "force", label: "🔥 Force", hint: "Overwrite remote" },
          ],
        }),
      ok: () => confirm({ message: "Start Build & Release?" }),
    },
    { onCancel: () => process.exit(0) }
  );

  if (!config.ok) return;

  const s = spinner();
  try {
    s.start(pc.dim("🔄 Syncing origin"));
    sh("git fetch origin main");
    s.message(pc.dim("📦 Installing deps"));
    sh("pnpm install");

    // Only run build if it exists
    const hasBuild =
      sh(
        'node -p "require(\'./package.json\').scripts?.build ? \'yes\' : \'no\'"',
        true
      ) === "yes";

    if (hasBuild) {
      s.message(pc.dim("🛠️  Building project"));
      sh("pnpm run build");
    } else {
      note("No build script found, skipping build.", "ℹ Build");
    }

    s.message(pc.dim("📝 Staging files"));
    sh("git add .");
    s.stop(pc.green("✔ Build Pipeline Success"));
  } catch (e) {
    s.stop(pc.red("✖ Pipeline Failed"));
    ui.die(e.message);
  }

  let commitInfo = { msg: "Manual/No Commit", desc: "No changes" };
  const diff = git.rawDiff();

  if (diff) {
    const ai = await generateCommit(diff);
    note(pc.italic(wrap(ai.desc, 60)), "📋 AI Summary");

    const msg = await text({ message: "Commit Message", initialValue: ai.msg });
    if (isCancel(msg)) process.exit(0);

    sh(`git commit -m "${String(msg).replace(/"/g, '\\"')}"`);
    console.log(pc.green("✔ Committed"));
    commitInfo = { msg: String(msg), desc: ai.desc };
  } else {
    note("No changes to commit", "ℹ Skip");
  }

  const rb = spinner();

  // Ensure start() ALWAYS happens before try/catch
  const startMsg =
    config.type !== "none" ? `🔖 Bumping ${config.type}...` : "🚀 Preparing push...";
  rb.start(pc.blue(startMsg));

  try {
    if (config.type !== "none") {
      sh(`pnpm version ${config.type}`);
    }

    rb.message(pc.blue("🚀 Pushing to origin"));
    const cmd =
      config.push === "force"
        ? "git push origin HEAD --force --tags"
        : "git push origin HEAD --tags";
    sh(cmd);

    await logToSheet({
      user: git.user(),
      branch: git.branch(),
      type: String(config.type),
      message: commitInfo.msg,
      description: commitInfo.desc,
    });

    rb.stop(pc.green("✔ Deployed"));
  } catch {
    rb.stop(pc.red("✖ Push Failed. Rolling back"));
    try {
      if (config.type !== "none") {
        const tag = sh("git describe --tags --abbrev=0", true);
        if (tag) sh(`git tag -d ${tag}`);
      }
      sh("git reset --soft HEAD~1");
      note("Tag deleted & commit reset.", "✅ Rollback");
    } catch {
      // ignore
    }
    process.exit(1);
  }
}

async function flowBranch() {
  if (!git.isRepo()) ui.die("Not a git repository. Run `otto` inside a repo.");

  const branches = sh('git branch --format="%(refname:short)"', true)
    .split("\n")
    .map((b) => b.trim())
    .filter(Boolean);

  const curr = git.branch();

  const action = await select({
    message: "Branch Manager",
    options: [
      { value: "switch", label: "🔀 Switch", hint: "Auto-Stash & Switch" },
      { value: "create", label: "✨ Create", hint: "From current" },
      { value: "update", label: "🔄 Update", hint: "Pull main into current" },
      { value: "pr", label: "🌐 Open PR", hint: "View on GitHub" },
    ],
  });

  if (isCancel(action)) process.exit(0);

  // --- SWITCH ---
  if (action === "switch") {
    const target = await select({
      message: "Select Branch",
      options: branches
        .filter((b) => b !== curr)
        .map((b) => ({ value: b, label: b })),
    });
    if (isCancel(target)) process.exit(0);

    const s = spinner();
    s.start(pc.dim("Switching branches"));

    // 1. Auto Stash
    const stashed = git.stash();
    if (stashed) s.message(pc.dim("Changes stashed"));

    // 2. Checkout
    try {
      sh(`git checkout ${target}`);
      s.message(pc.dim(`Switched to ${target}`));
    } catch {
      s.stop(pc.red("✖ Checkout Failed"));
      return;
    }

    // 3. Auto Pop
    if (stashed) {
      s.message(pc.dim("Restoring changes"));
      const popped = git.pop();
      if (!popped) {
        s.stop(pc.yellow("⚠ Switched, but stash pop had conflicts."));
        note("Run 'git stash pop' manually to resolve.", "Conflict Alert");
        return;
      }
    }

    s.stop(pc.green(`✔ Switched to ${target}`));
  }

  // --- UPDATE ---
  if (action === "update") {
    const s = spinner();
    s.start(pc.dim("Fetching main"));
    try {
      sh("git fetch origin main");
      s.message(pc.dim("Pulling changes"));
      sh("git pull origin main");
      s.stop(pc.green("✔ Branch updated from main"));
    } catch (e) {
      s.stop(pc.red("✖ Update Failed"));
      note(e.message, "Git Error");
    }
  }

  // --- CREATE ---
  if (action === "create") {
    const name = await text({ message: "Branch Name", placeholder: "feat/new-thing" });
    if (isCancel(name)) process.exit(0);
    sh(`git checkout -b ${name}`);
    outro(pc.green(`Created ${name}`));
  }

  // --- PR ---
  if (action === "pr") {
    const url = sh("git config --get remote.origin.url", true)
      .replace(".git", "")
      .replace(":", "/")
      .replace("git@", "https://");

    const prUrl = `${url}/pull/new/${curr}`;
    sh(process.platform === "darwin" ? `open ${prUrl}` : `start ${prUrl}`, true);
    outro(pc.green("Opened PR in browser"));
  }
}

// --- Main ---
const program = new Command();
program.name("otto").description("AI-powered Release CLI").version("2.1.0");

program.command("release").action(async () => {
  ui.banner();
  await flowRelease();
});

program.command("branch").action(async () => {
  ui.banner();
  await flowBranch();
});

if (!process.argv.slice(2).length) {
  ui.banner();
  select({
    message: "What's the plan?",
    options: [
      { value: "release", label: "🚀 Release", hint: "Build, Tag, Push" },
      { value: "branch", label: "🌿 Branch", hint: "Switch, Update, PR" },
      { value: "quit", label: "🚪 Quit" },
    ],
  }).then(async (op) => {
    if (isCancel(op) || op === "quit") process.exit(0);
    if (op === "release") await flowRelease();
    if (op === "branch") await flowBranch();
  });
} else {
  program.parse(process.argv);
}
