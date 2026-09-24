# Superpowers skills (vendored)

The skill folders below in `.claude/skills/` are an unmodified copy of the
`skills/` directory of [obra/superpowers](https://github.com/obra/superpowers)
by Jesse Vincent, MIT-licensed (see `LICENSE` in this folder).

- Version: 6.4.1
- Upstream commit: `5bf4e78011075bcfc0dc295f0724994cd123ee71` (2026-09-18)

They are committed here because Claude Code cloud sessions don't install
plugins declared in `.claude/settings.json`, but do load skills from the
repo's `.claude/skills/`.

Vendored skills: brainstorming, diagnosing-superpowers,
dispatching-parallel-agents, executing-plans, finishing-a-development-branch,
receiving-code-review, requesting-code-review, subagent-driven-development,
systematic-debugging, test-driven-development, using-git-worktrees,
using-superpowers, verification-before-completion, writing-plans,
writing-skills.

## Differences from the plugin

- Only the skills are included, not the plugin's SessionStart hook, so
  `using-superpowers` is not injected automatically at session start. Invoke
  it with `/using-superpowers` when you want it.
- The skills refer to each other as `superpowers:<name>`. Loaded as project
  skills, their names have no prefix (e.g. `brainstorming`).

## Updating

```bash
git clone --depth 1 https://github.com/obra/superpowers.git /tmp/superpowers
for d in /tmp/superpowers/skills/*/; do
  rm -rf ".claude/skills/$(basename "$d")"
  cp -a "$d" .claude/skills/
done
cp /tmp/superpowers/LICENSE .claude/superpowers/LICENSE
```

Then update the version and commit above (version is in
`/tmp/superpowers/.claude-plugin/plugin.json`).
