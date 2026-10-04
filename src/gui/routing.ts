export type ProcessMode =
  | { kind: "gui" }
  | { kind: "scheduled"; accountId: string; storeId: string | null; scheduleId: string }
  | { kind: "scheduled-dry-run"; accountId: string; storeId: string | null; scheduleId: string }
  | { kind: "scheduled-task-resume"; scheduleId: string };

export function resolveProcessMode(argv: string[]): ProcessMode {
  const taskResumeAt = argv.indexOf("--scheduled-task-resume");
  if (taskResumeAt >= 0) {
    return { kind: "scheduled-task-resume", scheduleId: argv[taskResumeAt + 1] ?? "" };
  }
  const dryRunAt = argv.indexOf("--scheduled-dry-run");
  if (dryRunAt >= 0) {
    const accountId = argv[dryRunAt + 1] ?? "";
    const second = argv[dryRunAt + 2] ?? "";
    const third = argv[dryRunAt + 3];
    return third === undefined
      ? { kind: "scheduled-dry-run", accountId, storeId: null, scheduleId: second }
      : { kind: "scheduled-dry-run", accountId, storeId: second || null, scheduleId: third };
  }
  const scheduledAt = argv.indexOf("--scheduled-runner");
  if (scheduledAt >= 0) {
    const accountId = argv[scheduledAt + 1] ?? "";
    const second = argv[scheduledAt + 2] ?? "";
    const third = argv[scheduledAt + 3];
    return third === undefined
      ? { kind: "scheduled", accountId, storeId: null, scheduleId: second }
      : { kind: "scheduled", accountId, storeId: second || null, scheduleId: third };
  }
  return { kind: "gui" };
}
