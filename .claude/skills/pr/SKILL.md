---
name: pr
description: Write and open a pull request using Ethan's PR format. Use whenever the user asks to open, create, or write a PR or pull request description.
---

When asked to create a PR:

1. Run `git log main..HEAD --oneline` and `git diff main...HEAD --stat`, then read the
   changed files so the description is accurate.
2. Find the issue number from the branch name or commit messages. If you can't, ask.
3. Fill in the template below. Rules:
   - Split modifications into Major (new files, core logic) and Minor(ish) (config,
     deps, small tweaks). Use backticked file paths with a short, specific description.
   - Testing steps must be concrete things a reviewer can click through.
   - Add a Setup line only if new env vars, restarts, or installs are needed.
   - Leave all checkboxes unchecked except "The developer name is specified",
     unless I say otherwise.
   - Leave the Screenshots section as a placeholder for me to fill in.
4. Show me the draft before opening it. Once I approve, write it to a temp file and run
   `gh pr create --title "<conventional commit style title>" --body-file <file>`.

## Template

```
## Developer: Ethan Ikenaga

Closes #<issue>

### Pull Request Summary

<1–2 sentences: what this adds/fixes, and what it was like before>

### Modifications

Major:
- `<path>`: <what changed>

Minor(ish):
- `<path>`: <what changed>

### Testing Considerations

**Setup:** <env vars / restarts needed, or remove this line>

### Pull Request Checklist

- [ ] Code is neat, readable, and works
- [ ] Comments are appropriate
- [ ] The summary is completed

### Screenshots/Screencast

<!-- add screenshots or video -->
```
