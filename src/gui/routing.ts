export type ProcessMode =
  | { kind: "gui" }
  | { kind: "scheduled"; profileId: string; storeId: string; scheduleId: string }
  | { kind: "scheduled-dry-run"; profileId: string; storeId: string; scheduleId: string }
  | { kind: "scheduled-task-resume"; scheduleId: string };

export function resolveProcessMode(argv: string[]): ProcessMode {
  const taskResumeAt = argv.indexOf("--scheduled-task-resume");
  if (taskResumeAt >= 0) {
    return { kind: "scheduled-task-resume", scheduleId: argv[taskResumeAt + 1] ?? "" };
  }
  const dryRunAt = argv.indexOf("--scheduled-dry-run");
  if (dryRunAt >= 0) {
    return {
      kind: "scheduled-dry-run",
      profileId: argv[dryRunAt + 1] ?? "",
      storeId: argv[dryRunAt + 2] ?? "",
      scheduleId: argv[dryRunAt + 3] ?? "",
    };
  }
  const scheduledAt = argv.indexOf("--scheduled-runner");
  if (scheduledAt >= 0) {
    return {
      kind: "scheduled",
      profileId: argv[scheduledAt + 1] ?? "",
      storeId: argv[scheduledAt + 2] ?? "",
      scheduleId: argv[scheduledAt + 3] ?? "",
    };
  }
  return { kind: "gui" };
}
