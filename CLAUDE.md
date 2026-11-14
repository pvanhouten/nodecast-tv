# Repo rules (pvanhouten/nodecast-tv fork)

- **Clean up branches after they are merged to `main`.** Once a PR is merged, delete its branch on GitHub
  (`git push origin --delete <branch>` or `gh api -X DELETE repos/pvanhouten/nodecast-tv/git/refs/heads/<branch>`)
  and delete the local copy (`git branch -d <branch>`, then `git fetch --prune`). Before deleting, confirm the branch
  has nothing unmerged: `git rev-list --count origin/main..origin/<branch>` must be 0. Never delete `main`.
  Rollback images and tags are not branches; leave them alone.
