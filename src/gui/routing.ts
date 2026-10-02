export type ProcessMode =
  | { kind: "gui" }
  | { kind: "scheduled"; accountId: string; scheduleId: string }
  | { kind: "scheduled-dry-run"; accountId: string; scheduleId: string }
  | { kind: "scheduled-task-resume"; scheduleId: string };

export function resolveProcessMode(argv: string[]): ProcessMode {
  const taskResumeAt = argv.indexOf("--scheduled-task-resume");
  if (taskResumeAt >= 0) {
    return { kind: "scheduled-task-resume", scheduleId: argv[taskResumeAt + 1] ?? "" };
  }
  const dryRunAt = argv.indexOf("--scheduled-dry-run");
  if (dryRunAt >= 0) {
    return { kind: "scheduled-dry-run", accountId: argv[dryRunAt + 1] ?? "", scheduleId: argv[dryRunAt + 2] ?? "" };
  }
  const scheduledAt = argv.indexOf("--scheduled-runner");
  if (scheduledAt >= 0) {
    return { kind: "scheduled", accountId: argv[scheduledAt + 1] ?? "", scheduleId: argv[scheduledAt + 2] ?? "" };
  }
  return { kind: "gui" };
}
