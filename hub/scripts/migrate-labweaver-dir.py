#!/usr/bin/env python3
"""Move a user's .claude/ folder to the labweaver folder, .labweaver/.

Usage: migrate-labweaver-dir.py <user> [--pg-container NAME] [--dry-run]

Run while the user's container is stopped (it writes transcripts and Auto
markers into the folder). The indexer may keep running: the stored
file_offsets paths are rewritten first, and mv keeps each transcript's inode,
so the indexer resumes at the same offsets instead of replaying.

  hub/workspaces/<user>/.claude/                → .labweaver/
  .labweaver/claude-projects/                   → .labweaver/projects/
  .labweaver/chats/ (legacy sidecars, imported) → removed
  commands/*.md, agents/*.md                    → new skeleton if unedited, else paths rewritten
  ~/.claude paths inside settings.json          → ~/.labweaver
  hooks/*.sh                                    → refreshed from hub/skeleton/harness/hooks
"""
import argparse
import pathlib
import shutil
import subprocess
import sys

HUB = pathlib.Path(__file__).resolve().parent.parent

ap = argparse.ArgumentParser()
ap.add_argument("user")
ap.add_argument("--pg-container", default="labweaver-dev-postgres")
ap.add_argument("--dry-run", action="store_true")
args = ap.parse_args()

ws = HUB / "workspaces" / args.user
old, new = ws / ".claude", ws / ".labweaver"
if not old.is_dir():
    sys.exit(f"{old} not found (already migrated?)")
if new.exists():
    sys.exit(f"{new} already exists; refusing to merge")
chats = old / "chats"
if chats.is_dir() and not (chats / ".imported").exists():
    sys.exit(f"{chats} has sidecars that were never imported; refusing to delete them")


def step(msg):
    print(("[dry-run] " if args.dry_run else "") + msg)
    return not args.dry_run


# 1. Offsets first, so the indexer never sees a moved transcript as new.
old_prefix = f"/workspaces/{args.user}/.claude/claude-projects/"
new_prefix = f"/workspaces/{args.user}/.labweaver/projects/"
sql = ("UPDATE file_offsets SET jsonl_path = %s || substr(jsonl_path, %d) "
       "WHERE username = %s AND jsonl_path LIKE %s")
sql = sql % (f"'{new_prefix}'", len(old_prefix) + 1, f"'{args.user}'", f"'{old_prefix}%'")
if step(f"file_offsets: {old_prefix} → {new_prefix}"):
    out = subprocess.check_output(
        ["docker", "exec", args.pg_container, "psql", "-U", "labweaver", "-d", "labweaver", "-Atc", sql], text=True)
    print("  ", out.strip())

# 2. Move the folder.
if step(f"mv {old} → {new}"):
    old.rename(new)
root = new if not args.dry_run else old
if (root / "claude-projects").is_dir() and step("mv claude-projects → projects"):
    (root / "claude-projects").rename(root / "projects")
if (root / "chats").is_dir() and step("rm -r chats (imported legacy sidecars)"):
    shutil.rmtree(root / "chats")

# 3. Paths written inside the folder's files. Command and agent copies the
# user never edited (still the pre-rename skeleton) take the new skeleton;
# edited ones get their paths rewritten.
PRE_RENAME = "be135b0"  # last commit with the .claude layout
skeleton = HUB / "skeleton" / "harness"


def pre_rename_skeleton(sub):
    try:
        return subprocess.check_output(["git", "-C", str(HUB), "show", f"{PRE_RENAME}:hub/skeleton/harness/{sub}"],
                                       text=True, stderr=subprocess.DEVNULL)
    except subprocess.CalledProcessError:
        return None


for f in [root / "settings.json", *root.glob("commands/*.md"), *root.glob("agents/*.md")]:
    if not f.is_file():
        continue
    s = f.read_text()
    sub = f"{f.parent.name}/{f.name}"
    if f.name != "settings.json" and s == pre_rename_skeleton(sub) and (skeleton / sub).is_file():
        if step(f"refresh {sub} from the skeleton (unedited copy)"):
            shutil.copy2(skeleton / sub, f)
        continue
    t = s.replace("$HOME/.claude/", "$HOME/.labweaver/").replace("~/.claude/", "~/.labweaver/") \
         .replace("/home/node/.claude/", "/home/node/.labweaver/")
    if t != s and step(f"rewrite ~/.claude paths in {f.relative_to(root)}"):
        f.write_text(t)

hooks = root / "hooks"
if hooks.is_dir() and not hooks.is_symlink() and step("refresh hooks/*.sh from the skeleton"):
    for src in (HUB / "skeleton" / "harness" / "hooks").glob("*.sh"):
        shutil.copy2(src, hooks / src.name)
if (root / "settings.json").is_file() and step("merge harness hooks into settings.json"):
    subprocess.check_call([sys.executable, str(HUB / "scripts" / "merge-harness-hooks.py"), str(root / "settings.json")])

print("done" if not args.dry_run else "dry run: nothing changed")
