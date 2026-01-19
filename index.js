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

const SHEET_WEBHOOK_URL = process.env.GOOGLE_SHEET_WEBHOOK_URL;

const sh = (cmd, ignore = false) => {
  try {
    return execSync(cmd, { stdio: "pipe" }).toString().trim();
  } catch (e) {
    if (!ignore)
      throw new Error(e?.stderr?.toString() || e?.message || String(e));
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
    const b = sh("git symbolic-ref --short -q HEAD", true);
    if (b) return b;
    const d = sh("git rev-parse --short HEAD", true);
    return d ? `detached@${d}` : "unborn";
  },

  user: () => sh("git config user.name", true) || "Ghost",

  diff: (staged = true) =>
    sh(`git diff ${staged ? "--cached" : ""} --stat`, true),

  rawDiff: () => sh("git diff --cached", true),

  stash: () => {
    if (!git.isRepo()) return false;
    const isDirty = sh("git status --porcelain", true).length > 0;
    if (!isDirty) return false;
    sh('git stash push -m "Otto Auto-Switch"', true);
    return true;
  },

  pop: () => {
    if (!git.isRepo()) return false;
    try {
      sh("git stash pop");
      return true;
    } catch {
      return false;
    }
  },

  // NEW: Fetch parsed git log
  log: (limit = 10) => {
    if (!git.isRepo()) return [];
    // Format: hash | message | author | relative_time
    const out = sh(
      `git log -n ${limit} --pretty=format:"%h|%s|%an|%ar"`,
      true
    );
    if (!out) return [];
    return out.split("\n").map((line) => {
      const [hash, msg, author, time] = line.split("|");
      return { hash, msg, author, time };
    });
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
        "You're not inside a git repository. Commands need a repo.",
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

// NEW: Undo Flow
async function flowUndo() {
  if (!git.isRepo()) ui.die("Not a git repository.");

  const s = spinner();
  s.start(pc.dim("Fetching history"));
  const history = git.log(15); // Fetch last 15 commits
  s.stop(pc.dim("History loaded"));

  if (!history.length) {
    note("No commit history found to undo.", "ℹ Empty");
    return;
  }

  const targetHash = await select({
    message: "Reset branch to which commit?",
    options: history.map((c, i) => {
      // Mark the current HEAD
      const label = i === 0 ? `${c.msg} (Current)` : c.msg;
      return {
        value: c.hash,
        label: `${pc.cyan(c.hash)} ${label}`,
        hint: `${c.author}, ${c.time}`,
      };
    }),
  });

  if (isCancel(targetHash)) process.exit(0);

  // If they selected the current HEAD, there is nothing to do
  if (targetHash === history[0].hash) {
    outro(pc.yellow("You selected the current commit. No changes made."));
    return;
  }

  const resetMode = await select({
    message: "How should we reset?",
    options: [
      {
        value: "--soft",
        label: "🧸 Soft Reset",
        hint: "Keep changes staged (Undo commit only)",
      },
      {
        value: "--mixed",
        label: "🚧 Mixed Reset",
        hint: "Keep changes in working dir (Unstaged)",
      },
      {
        value: "--hard",
        label: "🧨 Hard Reset",
        hint: "DESTROY changes (Go back in time)",
      },
    ],
  });

  if (isCancel(resetMode)) process.exit(0);

  // Safety check for Hard Reset
  if (resetMode === "--hard") {
    const safe = await confirm({
      message: pc.red("⚠️  This will delete all uncommitted changes. Sure?"),
    });
    if (!safe || isCancel(safe)) {
      outro(pc.dim("Operation cancelled."));
      return;
    }
  }

  const r = spinner();
  r.start(pc.yellow(`Resetting to ${targetHash}...`));

  try {
    sh(`git reset ${resetMode} ${targetHash}`);
    r.stop(pc.green(`✔ Reset complete (${resetMode})`));
    
    if (resetMode === "--soft") {
      note("Your changes are now staged and ready to be modified.", "ℹ Soft Reset");
    } else if (resetMode === "--mixed") {
      note("Your changes are in the working directory (unstaged).", "ℹ Mixed Reset");
    } else {
      note(`HEAD is now at ${targetHash}`, "ℹ Hard Reset");
    }

  } catch (e) {
    r.stop(pc.red("✖ Reset failed"));
    console.error(e.message);
  }
}

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
  
  // ... (Rest of release flow remains identical) ...
  // [Code shortened for brevity, keep your original release logic here]
  
  // Start Build
  const s = spinner();
  try {
    s.start(pc.dim("🔄 Syncing origin"));
    sh("git fetch origin main");
    s.message(pc.dim("📦 Installing deps"));
    sh("pnpm install");

    const hasBuild = sh('node -p "require(\'./package.json\').scripts?.build ? \'yes\' : \'no\'"', true) === "yes";

    if (hasBuild) {
      s.message(pc.dim("🛠️  Building project"));
      sh("pnpm run build");
    } 

    s.message(pc.dim("📝 Staging files"));
    sh("git add .");
    s.stop(pc.green("✔ Build Pipeline Success"));
  } catch (e) {
    s.stop(pc.red("✖ Pipeline Failed"));
    ui.die(e.message);
  }

  // Commit
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

  // Push / Publish
  const rb = spinner();
  const startMsg = config.type !== "none" ? `🔖 Bumping ${config.type}...` : "🚀 Preparing push...";
  rb.start(pc.blue(startMsg));

  try {
    if (config.type !== "none") {
      sh(`pnpm version ${config.type}`);
    }

    rb.message(pc.blue("🚀 Pushing to origin"));
    const cmd = config.push === "force" ? "git push origin HEAD --force --tags" : "git push origin HEAD --tags";
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
    } catch { /* ignore */ }
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
      options: branches.filter((b) => b !== curr).map((b) => ({ value: b, label: b })),
    });
    if (isCancel(target)) process.exit(0);

    const s = spinner();
    s.start(pc.dim("Switching branches"));
    const stashed = git.stash();
    
    try {
      sh(`git checkout ${target}`);
      s.message(pc.dim(`Switched to ${target}`));
    } catch {
      s.stop(pc.red("✖ Checkout Failed"));
      return;
    }

    if (stashed) {
      s.message(pc.dim("Restoring changes"));
      if (!git.pop()) {
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

// NEW Command
program.command("undo").action(async () => {
  ui.banner();
  await flowUndo();
});

if (!process.argv.slice(2).length) {
  ui.banner();
  select({
    message: "What's the plan?",
    options: [
      { value: "release", label: "🚀 Release", hint: "Build, Tag, Push" },
      { value: "branch", label: "🌿 Branch", hint: "Switch, Update, PR" },
      { value: "undo", label: "⏪ Undo", hint: "Rewind commits" }, // Added here
      { value: "quit", label: "🚪 Quit" },
    ],
  }).then(async (op) => {
    if (isCancel(op) || op === "quit") process.exit(0);
    if (op === "release") await flowRelease();
    if (op === "branch") await flowBranch();
    if (op === "undo") await flowUndo();
  });
} else {
  program.parse(process.argv);
}