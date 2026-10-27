import { ScheduledTasks } from "../../dist/tasks/index.js";

const { config, input, paused } = JSON.parse(process.argv[2]);
const tasks = new ScheduledTasks(config, () => {});
const signal = new AbortController().signal;
await tasks.load();
await tasks.create("crash", input, signal);
await tasks.setPaused("crash", paused, signal);
const run = await tasks.start("crash", "unknown", signal);
console.log(JSON.stringify(run));
