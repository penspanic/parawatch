# Long jobs that leave no agent log

`parawatch guide runs` prints this page for the installed version.

A render, a benchmark, an editor build, a CI run or a deploy you are waiting on. The simplest way is to run it through parawatch:

```
parawatch run watch "CI for #88" -p api -- gh run watch 123 --exit-status
parawatch run watch "Nightly bench" -p game --heartbeat 600 -- ./bench.sh
```

The run starts before the command, shows under your session while it runs, and ends with it: done on exit code 0, failed otherwise with the code. With `--heartbeat`, the command's output counts as beats, so a command that goes quiet that long shows as stalled. The exit code is passed on. In Claude Code, run a long one as a background command (`run_in_background: true`): its exit wakes you like a wait.

For a job you cannot wrap in one command (it runs elsewhere, or you start it and come back), declare it by hand:

```
id=$(parawatch run start -p <project> "overnight bench" --heartbeat 600 --log /path/bench.log)
parawatch run note $id "scene 3 of 8"   # also counts as a beat
parawatch run beat $id                  # still alive, nothing to say
parawatch run end $id                   # or: parawatch run end $id --failed -n "editor stopped ticking"
```

The run shows under your session. With `--heartbeat`, it turns stalled when no beat, note or log change comes in that many seconds, so a job that hangs silently (a locked screen, App Nap) shows at once. End it when it ends, or it keeps showing as working. Do not poll a job with sleep loops; declare it and arm a wait.

Do not declare runs for things parawatch already sees in their own logs: Claude Code sessions and subagents, and `codex exec` jobs, show up by themselves. A declared run on top of them is a duplicate.
