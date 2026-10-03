/**
 * Minimal ambient declaration for node-cron (the package ships no types).
 */
declare module "node-cron" {
  interface ScheduledTask {
    stop(): void;
    start(): void;
    destroy(): void;
    getStatus(): string;
  }

  interface ScheduleOptions {
    scheduled?: boolean;
    timezone?: string;
  }

  function schedule(
    expression: string,
    func: () => void,
    options?: ScheduleOptions,
  ): ScheduledTask;

  function getTasks(): Map<string, ScheduledTask>;

  export default { schedule, getTasks };
}